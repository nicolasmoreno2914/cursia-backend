import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  NotImplementedException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { executionLeaseView, ExecutionLeaseView, normalizeRequestingExecutorId } from '../reliability/execution-lease';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { GenerationManifestsService, ManifestDto } from '../generation-manifests/generation-manifests.service';
import { itemTypesForRulesVersion } from '../generation-manifests/generation-manifest-builder';
import type { ManifestItemType } from '../generation-manifests/generation-manifest-builder';
import { CostRatesService } from '../../admin/services/cost-rates.service';
import { CourseContextDto, RUN_VIDEO_MODES, RunVideoMode } from './dto/course-context.dto';
import { REQUIRED_CONTEXT_FIELDS, canonicalContextHash, itemIdempotencyKey, normalizeCourseContext } from './run-hash';
import {
  VideoDeliveryGateResult,
  VideoDeliveryStrategy,
  VideoDeliveryView,
  YOUTUBE_PREFLIGHT_FAILED,
  YoutubePreflightResult,
  canonicalYoutubeWatchUrl,
  deliveryViewOf,
  frozenRunVideoGate,
  frozenVideoDeliveryOf,
  normalizeDeliveryState,
  readVideoDeliveryConfig,
  resolveRunVideoDelivery,
  youtubePreflightFailedMessage,
  youtubeVideoVerifyMessage,
} from './dynamic-video-delivery';
import { DynamicYoutubePreflightService } from './dynamic-youtube';
import { assertDynamicOwnerAllowed, assertRealVideoAllowed, assertVideoPreviewAllowed } from '../features/dynamic-features';
import { FromRunDto, isFromRunRequest } from '../invalidation/dto/from-run.dto';
import { computePlanFromDb, executeApplyWrites, planApplyWrites } from '../invalidation/invalidation-apply';
import { requiredArtifactTypesForPresent } from '../dynamic-packaging/artifact-resolver';
import { regenerationCascade } from './regeneration-cascade';
import {
  PROVIDER_MODES_CONFLICT,
  PROVIDER_MOCK_NOT_ALLOWED,
  ProviderModeError,
  ProviderModes,
  frozenProviderModesOf,
  isProviderWorkerDeployed,
  providerWorkerNotDeployedMessage,
  resolveProviderModes,
  sameProviderModes,
} from './provider-modes';
import {
  PROVIDER_NOT_READY,
  V3_REQUIRES_YOUTUBE_DELIVERY,
  providerNotReadyMessage,
  providerReadinessMissing,
  v3RequiresYoutubeMessage,
  v3VideoDeliveryOk,
} from './provider-readiness';
import { INVALIDATION_V3_NOT_IMPLEMENTED, assertInvalidationRulesSupported } from '../invalidation/plan';
import { latestGenerationPredicate } from './item-generations';
import {
  AUTO_HEAL_SQL_ALLOW_REGEX,
  AUTO_HEAL_SQL_DENY_REGEX,
  AUTO_HEAL_MAX_AGE_HOURS_RANGE,
  AUTO_HEAL_SKIP_COOLDOWN_SECONDS,
  AUTO_HEAL_WORKER_ITEM_TYPES,
  AutoHealPolicy,
  AutoHealSweepResult,
  AUTO_HEAL_PERMANENT_SKIPS,
  AutoHealKind,
  autoHealDecision,
  autoHealMaxRoundsFor,
  autoHealPolicyFromEnv,
  autoHealRoundsOf,
  autoRegenRoundsOf,
  autoRecoveryEnabled,
  SAFE_AUTO_RETRY_MAX_ROUNDS,
  SAFE_AUTO_RETRY_SQL_REGEX,
  safeAutoRetryDecision,
  AMBIGUOUS_AUDIO_RESUBMIT_CODE,
  AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS,
  AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD,
  AMBIGUOUS_AUDIO_RESUBMIT_SQL_REGEX,
  AMBIGUOUS_AUDIO_RESUBMIT_TYPES,
  AmbiguousAudioPending,
  ambiguousAudioResubmitDecision,
} from './auto-heal';
import { FinopsBudgetService, StartBudgetEvaluation } from '../finops/finops-budget.service';
import {
  BUDGET_APPROVAL_REQUIRED,
  BUDGET_BLOCKED,
  BUDGET_EXCEEDED,
  PROVIDER_RECONCILIATION_REQUIRED,
  FINOPS_UNAVAILABLE,
  RunManifestItem,
  RunSpendModes,
  estimateItemsForRun,
  runSpendModes,
  spendModeOfItemType,
  estimateSummary,
  paidProviderOfItemType,
  paidRealProviders,
  decideRunBudget,
} from '../finops/run-budget';
import { incrementalCostForPlan } from '../finops/incremental';
import { FinopsError } from '../finops/errors';
import { addDec, cmpDec, normalizeDecimal } from '../finops/decimal';
import { runtimeGuard, SpentSoFar } from '../finops/budget';
import { MONTH_CAP_LOCK } from '../finops/finops-budget.service';
import type { EstimateResult, MinExpMax } from '../finops/estimator';
import { assertAssessmentProfileResolvableForRun } from '../course-profiles/assessment-preflight';
import { randomUUID } from 'crypto';
import {
  VIDEO_MODE_INCONSISTENT,
  VIDEO_UPGRADE_CASCADE_REASON,
  VIDEO_UPGRADE_NOT_ALLOWED_RULES,
  VIDEO_UPGRADE_NOTHING_PENDING,
  VIDEO_UPGRADE_REASON,
  VIDEO_UPGRADE_RUN_NOT_READY,
  VIDEO_UPGRADE_AMBIGUOUS_SUBMISSION,
  VIDEO_UPGRADE_IN_FLIGHT_STATES,
  VideoUpgradeRecord,
  fallbackVideoModeOf,
  isUpgradeGeneration,
  questionsBelongToVideo,
  runIsUpgradeOnlyFailure,
  upgradedVideoKeysOf,
  videoModeInconsistentMessage,
  videoUpgradeFingerprint,
  videoUpgradeOf,
  videoUpgradesOf,
} from './video-upgrade';
import { estimateBreakdown, EstimateBreakdown, estimateCategories, estimateFingerprint, planNormalApproval, NormalApprovalPlan } from '../finops/normal-approval';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { RunCompletion, attachCarryChains, evaluateRunCompletion, loadPendingVideogenReservations, loadValidationCutoffs } from './run-completion';
import { hasDeliverablePackage } from '../dynamic-packaging/package-freshness';
import { autoPackageEnabled, loadAutoPackageState } from '../dynamic-packaging/auto-package-state';
import {
  ACTIVE_RUN_WORKER_STATUSES,
  isActiveRun,
  isCancelledLike,
  recomputeRunStatus,
  sweepRunExpiredLeases,
  takeCompletedRunsInTx,
} from './item-transitions';
import { AttemptActor, adminActor, recordItemReopened, recordItemsAbandoned } from '../reliability/attempt-log';
import { FailureProvider } from '../reliability/failure-classifier';
import {
  PROVIDER_PROBE_KEY,
  PROVIDER_PROBE_MAX_HOURS,
  PROVIDER_PROBE_RESUME_STRATEGY,
  PROVIDER_PROBE_SKIP_SECONDS,
  PROVIDER_PROBE_SQL_REGEX,
  PROVIDER_PROBE_STRATEGY,
  ProviderProbeRow,
  USER_STOPPED_SQL_REGEX,
  effectiveProbeStateOf,
  planProviderProbes,
  providerProbeEnabled,
  providerProbeStateOf,
} from '../reliability/provider-probe';
import { ItemCostView, ItemRecoveryView, loadItemCosts, recoveryViewOf } from './item-recovery-view';

export type ItemRunStatus = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'blocked' | 'cancelled';

const ITEM_STATUSES: ItemRunStatus[] = ['pending', 'running', 'retrying', 'completed', 'failed', 'blocked', 'cancelled'];
/** Estados de item que un cancel (o la reconciliación de un cancel legacy) pasa a `cancelled`. */
const NON_TERMINAL_ITEM_STATUSES = ['pending', 'running', 'retrying', 'blocked'];
/** worker_status de un run terminado en fallo (reabrible por startRun con el mismo contexto, R10). */
const FAILED_LIKE = new Set(['failed', 'failed_retryable', 'failed_recoverable']);
const ACTIVE_RUN_INDEX = 'uq_dynamic_generation_active_run';
/**
 * Generation con la que se siembra un run (5A y el apply de Fase 8). Las
 * regeneraciones explícitas (F78-BE2, regenerateItem) agregan generation 2, 3…
 * del MISMO run; la vigente de cada item la decide item-generations.ts.
 */
const GENERATION = 1;
/**
 * R17 + EV6 DoD (BE-A): default cuando el body no manda videoMode = REAL (un curso completo incluye
 * sus videos). `mock` solo con el escape de QA DYNAMIC_ALLOW_VIDEO_PREVIEW=true (403 si no).
 */
const DEFAULT_VIDEO_MODE: RunVideoMode = 'real';
/** Runs creados antes de R17 (sin `input_payload.videoMode`) nacieron en vista previa: se leen 'mock'. */
const LEGACY_VIDEO_MODE: RunVideoMode = 'mock';
/**
 * I1 (review-rv2): namespace del advisory lock por curso (pg_advisory_xact_lock(ns, courseId))
 * que serializa crear/reabrir/reintentar-con-reapertura runs de un curso.
 */
const COURSE_RUNS_LOCK_NS = 0x5c2a01;

export interface RunVideoEstimate {
  videoCount: number;
  videoChapterIds: Array<string | null>;
  estimatedVideoCostUsd: number | null;
  costSource: string | null;
  note: string;
}

export interface StatusCounts {
  total: number;
  pending: number;
  running: number;
  retrying: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
}

export interface RunProgress extends StatusCounts {
  /** completed / total (fracción 0..1). */
  pct: number;
  /** Claves = tipos del rulesVersion del Manifest del run (v1: content/scorm/video/exam, igual que antes). */
  byType: Partial<Record<ManifestItemType, StatusCounts>>;
}

export interface ItemRunDto {
  id: string;
  itemKey: string;
  type: ManifestItemType;
  /** null solo en items de scope course (rulesVersion 2). */
  moduleId: string | null;
  chapterId: string | null;
  dependsOn: string[];
  status: ItemRunStatus;
  generation: number;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  error: string | null;
  idempotencyKey: string;
  outputSummary: Record<string, any>;
  /**
   * DN-1: SOLO en items `video` — estado de entrega legible por la UI
   * (pending|rendering|completed_local|uploading_youtube|completed|
   * blocked_auth|blocked_quota|upload_failed|ambiguous) + acciones posibles.
   */
  delivery?: VideoDeliveryView;
  /**
   * REL R2 (aditivo): clase/código/estrategia del último fallo, rondas automáticas, próximo reintento,
   * espera y motivo de atención humana. Solo códigos (el texto sigue en `error`).
   */
  recovery: ItemRecoveryView;
  /** REL R2 (aditivo, solo en la vista del run): costo estimado / real / pendiente del item (ledger). Solo SUPER_ADMIN. */
  cost?: ItemCostView;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** DN-1: resumen de entrega de los videos del run (conteo por estado de `ItemRunDto.delivery`). */
export interface RunVideoDeliverySummary {
  total: number;
  byState: Record<string, number>;
  /** true si algún video espera una acción del usuario (reconectar, reintentar subida, resolver ambigua). */
  needsAttention: boolean;
}

export interface RunDto {
  id: string;
  courseId: number;
  manifestId: number;
  blueprintId: number;
  blueprintNumber: number;
  /** rulesVersion del Manifest congelado del run (contrato R2: el ejecutor decide los tipos a reclamar con esto). */
  rulesVersion: number;
  status: string;
  workerStatus: string;
  /**
   * R17: fijado al crear el run. Única excepción (EV6 T5 B2): el upgrade «Generar videos reales»
   * lo pasa UNA vez de 'mock' a 'real' (monótono); el original queda en `videoModeOriginal`.
   */
  videoMode: RunVideoMode;
  /** EV6 T5 B2: modo con el que nació el run si hubo upgrade de video (si no, ausente). */
  videoModeOriginal?: RunVideoMode;
  /** EV6 T5 B2: upgrade de videos de vista previa a reales (null si no hubo). */
  videoUpgrade?: VideoUpgradeRecord | null;
  /** EV6 T5 B2 (fix round 2, m-9): keys de video de TODOS los upgrades del run (historial incluido). */
  upgradedVideoKeys?: string[];
  /**
   * 5B.2.A: estrategia de entrega final del video, congelada al crear el
   * run desde DYNAMIC_VIDEO_DELIVERY; runs anteriores sin el campo →
   * 'videogen_direct'. Nunca cambia (ni al reabrir).
   */
  videoDelivery: VideoDeliveryStrategy;
  /** DN-1: resumen de la entrega de videos (null si el Manifest no tiene videos). */
  videoDeliverySummary: RunVideoDeliverySummary | null;
  courseContextSha256: string;
  courseContext: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  progress: RunProgress;
  items: ItemRunDto[];
  /**
   * EV6 DoD (BE-A): completitud COMPUTADA en cada lectura (run-completion.ts). `status` sigue siendo
   * el worker_status crudo; la UI decide «Curso listo» SOLO con `completion.complete`. Un run viejo
   * `completed` con componentes de vista previa se lee `state:'preview'` sin escribir nada.
   */
  completion: RunCompletion;
  /**
   * REL MVP fix round 1 (M3): recuperación automática activa en el servidor (tick + política por clase).
   * false (kill-switch `DYNAMIC_AUTO_HEAL_POLICY=legacy`) → el frontend no arranca el ejecutor solo al abrir.
   */
  autoRecovery: boolean;
  /**
   * REL MVP fix round 1 (I3): último claim o finalización de una parte del NAVEGADOR (cualquier ejecutor,
   * cualquier equipo). Obsoleto para decidir: lo reemplaza `executionLease` (se conserva para frontends
   * en caché anteriores al lease).
   */
  lastBrowserActivityAt: string | null;
  /**
   * REL lease de ejecución del navegador (servidor = autoridad): ¿algún ejecutor del navegador tiene el
   * lease vigente de este run, y es el `executorId` que consultó (?executorId=, estable por equipo)?
   * Solo informa: leer el run / el curso nunca depende del lease. null sin la migración.
   */
  executionLease: ExecutionLeaseView | null;
}

/** REL lease: quién consulta el run (solo para `executionLease.heldByYou`). */
export interface RunReadOptions {
  executorId?: string | null;
}

/** REL MVP fix round 1 (I3): último claim / finalización de una parte que ejecuta el navegador. */
export function lastBrowserActivityOf(rows: ReadonlyArray<{ type: string; status: string; claimed_at?: Date | string | null; finished_at?: Date | string | null }>): string | null {
  let best = 0;
  for (const r of rows) {
    if (AUTO_HEAL_WORKER_ITEM_TYPES.includes(r.type)) continue;
    for (const v of [r.claimed_at, r.status === 'completed' ? r.finished_at : null]) {
      const t = v ? new Date(v as any).getTime() : NaN;
      if (Number.isFinite(t) && t > best) best = t;
    }
  }
  return best ? new Date(best).toISOString() : null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function pgCode(err: any): string | undefined {
  return err?.code ?? err?.driverError?.code;
}

function pgConstraint(err: any): string | undefined {
  return err?.constraint ?? err?.driverError?.constraint;
}

function emptyCounts(): StatusCounts {
  return { total: 0, pending: 0, running: 0, retrying: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
}

const isActive = isActiveRun;

function isReopenable(job: { status?: string | null; worker_status?: string | null }): boolean {
  return isCancelledLike(job) || FAILED_LIKE.has(String(job.worker_status ?? '').trim());
}

function isActiveRunConflict(err: any): boolean {
  return pgCode(err) === '23505' && pgConstraint(err) === ACTIVE_RUN_INDEX;
}

/** Señal interna de startRunFromPrevious: el plan va a generar videos reales → correr el preflight fuera de la tx. */
class NeedsYoutubePreflight extends Error {
  constructor(public readonly gate: VideoDeliveryGateResult) {
    super('needs_youtube_preflight');
  }
}

/** `output_summary.delivery` tolerante (lectura): desconocido → 'pending' (el worker es el que valida fuerte). */
function deliveryStateOrPending(v: unknown): string {
  try {
    return normalizeDeliveryState(v);
  } catch {
    return 'pending';
  }
}

/** DN-1: la subida a YouTube de este item video quedó ambigua (empezó y no registró id). */
function isAmbiguousYoutubeUpload(row: { error?: string | null; output_summary?: Record<string, any> | null }): boolean {
  const os = row.output_summary ?? {};
  if (os.external?.youtubeVideoId) return false;
  return (
    os.delivery === 'ambiguous' ||
    String(row.error ?? '').startsWith('ambiguous_youtube_upload') ||
    (!!os.youtubeUploadStartedAt && os.delivery !== 'blocked_auth' && os.delivery !== 'blocked_quota')
  );
}

/** V2.1 RF-b: item bloqueado por el runtime guard de presupuesto (reanudable con retry). */
function isBudgetBlocked(row: { status?: string | null; error?: string | null }): boolean {
  return row.status === 'blocked' && String(row.error ?? '').startsWith(BUDGET_EXCEEDED);
}

export interface StartRunResult {
  created: boolean;
  reopened: boolean;
  run: RunDto;
  /** Fase 8: solo en runs creados con `{fromRun}` (resumen del plan aplicado). */
  invalidation?: { fromRunId: string; planSha256: string; totals: Record<string, number> };
}

/** DN-1: acción explícita sobre una subida a YouTube ambigua. */
export type YoutubeResolutionAction = 'confirm_existing' | 'authorize_reupload';

/** Código estable del 409 de un confirm_existing cuyo video no pasó la verificación en YouTube. */
export const YOUTUBE_VIDEO_NOT_VERIFIED = 'youtube_video_not_verified';

/** Código estable del 409 de un retry sobre una subida ambigua. */
export const YOUTUBE_UPLOAD_AMBIGUOUS = 'youtube_upload_ambiguous';

/** F78-BE2: qué cuesta regenerar un item. V2.1 (R4): + 'gamma' (presentation) y 'tts' (audio_*). */
export type RegenerationCostKind = 'videogen' | 'llm' | 'none' | 'gamma' | 'tts';

/**
 * Video en run 'real' → Videogen; video 'mock' → nada; presentation (v3) →
 * Gamma; audio_welcome/audiobook_chapter (v3) → TTS; cualquier otro tipo lo
 * genera un LLM (créditos). Gamma/TTS se declaran siempre (sin atajo 'mock'):
 * sus workers en modo real llaman a Gamma / OpenAI TTS (V2.1 F2).
 */
export function regenerationCostKind(type: string, videoMode: RunVideoMode): RegenerationCostKind {
  if (type === 'video') return videoMode === 'real' ? 'videogen' : 'none';
  if (type === 'presentation') return 'gamma';
  if (type === 'audio_welcome' || type === 'audiobook_chapter') return 'tts';
  return 'llm';
}

/** Estados de una generación nueva "en vuelo" (idempotencia de regenerateItem). */
const REGENERATION_IN_FLIGHT = new Set(['pending', 'running', 'retrying', 'blocked']);

export interface RegenerateItemResult {
  /** true = se creó una generación nueva (201); false = ya había una en vuelo (200, misma respuesta). */
  created: boolean;
  costKind: RegenerationCostKind;
  /** Fila (histórica, intacta) desde la que se regeneró. */
  previousItemRunId: string;
  previousGeneration: number;
  /** La generación nueva (vigente). */
  item: ItemRunDto;
  /**
   * Todos los items afectados, el pedido primero. Regenerar un content
   * además regenera scorm del capítulo + examen del módulo (REGENERATE, o
   * WAITS si todavía no se habían generado) y marca el video del capítulo
   * STALE_NO_AUTO (nunca lo regenera). Los demás tipos: solo el item.
   */
  affected: RegenerationAffectedItem[];
  run: RunDto;
}

export interface RegenerateItemOptions {
  confirmPaid?: boolean;
  /** Fix wave I1: planifica sin escribir nada. */
  dryRun?: boolean;
  /** Fix wave I2: generación vigente que vio el usuario; si cambió → 409 generation_changed. */
  expectedGeneration?: number;
  /**
   * REL MVP (reparación de empaque, sin humano): el validador del paquete rechazó el contenido de ESTE
   * item. Solo componentes de la IA (costo `llm`), sin cascada (regenera solo ese componente), una vez por
   * item (la generación nueva queda con `regeneration.reason = 'package_repair'`; otra → 409).
   */
  autoRepair?: { code: string };
}

/** REL MVP: motivo de la generación nueva creada por la reparación automática del empaque. */
export const PACKAGE_REPAIR_REASON = 'package_repair';

/** Fix wave I1: respuesta de `{dryRun:true}` (misma forma de `affected` que la llamada real). */
export interface RegenerateDryRunResult {
  dryRun: true;
  costKind: RegenerationCostKind;
  /** Generación vigente del item pedido (para mandarla como expectedGeneration). */
  currentGeneration: number;
  /** Lo que haría la llamada real; `itemRunId` es null en las generaciones que se crearían. */
  affected: RegenerationAffectedItem[];
  /** Trabas que la llamada real respondería con 403/409 (vacío = se puede confirmar). */
  blockers: Array<{ code: string; message: string }>;
  /**
   * V2.1 RF-b: costo incremental (min/esperado/max) y evitado por item afectado
   * (incrementalCostForPlan: evitado = costo real histórico primero, HD-V21-18).
   * null si el servicio de FinOps no está disponible (harness).
   */
  cost: RegenerationCostPreview | null;
}

/** V2.1 RF-b: vista de costo de una regeneración (dryRun). */
export interface RegenerationCostPreview {
  currency: string;
  incrementalCost: MinExpMax;
  avoided: string;
  byItem: Array<{
    itemKey: string;
    action: RegenerationAffectedItem['action'];
    incrementalCost: MinExpMax;
    avoided: string;
    avoidedBasis: 'historical_actual' | 'current_estimate' | null;
  }>;
}

/** V2.1 RF-b: señal interna del camino fromRun (plan calculado DENTRO de la tx): hace falta aprobación. */
class BudgetGateRejection extends Error {
  constructor(public readonly evaluation: StartBudgetEvaluation, public readonly code: string, public readonly planSha: string | null) {
    super(code);
  }
}

interface RegenerationBlocker {
  code: string;
  message: string;
  error: () => Error;
}

interface RegenerationPlan {
  inFlight: boolean;
  latest: any;
  currentGeneration: number;
  blockers: RegenerationBlocker[];
  affected: RegenerationAffectedItem[];
  cascade: Array<{ key: string; prev: any; costKind: RegenerationCostKind }>;
  /** Dependientes que quedan STALE_NO_AUTO (v1/v2: el video; v3: proveedores + video_interactions). */
  staleDeps: Array<{ key: string; row: any; action: RegenerationAffectedItem['action'] }>;
  staleArtifactIds: string[];
  stale: boolean;
}

export interface RegenerationAffectedItem {
  itemKey: string;
  type: string;
  /** null solo en un dryRun, para las generaciones que todavía no existen. */
  itemRunId: string | null;
  generation: number;
  /** REGENERATE = generación nueva; STALE_NO_AUTO = video marcado (sin regenerar); WAITS = aún no generado, usará el content nuevo; UNCHANGED = video fallido, sin cambios. */
  action: 'REGENERATE' | 'STALE_NO_AUTO' | 'WAITS' | 'UNCHANGED';
  created: boolean;
  costKind: RegenerationCostKind;
}

/**
 * Runs de generación dinámica (Fase 5A, Task 2): crear/sembrar, leer
 * progreso, cancelar, reintentar un item. Claim/complete/fail por item viven
 * en SchedulerService (Task 3); toda lectura del run barre leases vencidos y
 * recalcula su estado (R12) con las transiciones de item-transitions.ts.
 *
 * Modelo (spec §3.2–§3.5, §7):
 * - 1 run = 1 fila de `production_jobs` con execution_mode
 *   'dynamic_generation'. `input_payload = {manifestId, blueprintNumber,
 *   contextHash, videoMode, videoDelivery}` (manifestId SIEMPRE, como número — el índice único parcial
 *   uq_dynamic_generation_active_run solo protege filas con manifestId). El
 *   run nunca usa `lease_until`/`worker_id` (quedan NULL: el reaper legacy
 *   solo mira `lease_until IS NOT NULL`) ni `worker_status='waiting_child'`.
 * - El contexto congelado vive SOLO en `generation_run_contexts` (inmutable
 *   por trigger), con `context_hash` = forma canónica de run-hash.ts.
 * - Los items (`generation_item_runs`) se siembran del Manifest en la misma
 *   transacción que el job y el contexto.
 *
 * Ownership + `dynamic` + lectura verificada del Manifest se delegan en
 * `GenerationManifestsService.get` (404 ajeno/inexistente o sin Manifest,
 * 400 legacy). Nunca se crean Manifests acá.
 *
 * Cancelación legacy (R9): `POST /jobs/:id/cancel` no se modifica (rechaza
 * con 400 todo lo que no sea course_full_generation), pero `PATCH /jobs/:id`
 * legacy puede escribir `status='cancelled'`. Por eso toda lectura del run
 * reconcilia: si el job está cancelled/cancelling, los items no terminales
 * pasan a `cancelled` y el run se normaliza a status = worker_status =
 * 'cancelled' (lo que además libera el índice de run activo).
 */
export const ESTIMATE_STALE = 'estimate_stale';

/** Aprobación del flujo normal que startRun escribe DENTRO de la tx del run (ver finopsBindRun). */
export interface NormalApprovalRequest {
  approvedBy: string;
  fingerprint: string;
  /** Monto del plan que vio el usuario; se recalcula en la tx y debe coincidir. */
  amount: string;
  /** Totales del estimado que vio el usuario; el de startRun debe coincidir. */
  expected: string;
  max: string;
  /** Lo completa finopsBindRun al escribirla. */
  result: { authorizationId: string; amount: string } | null;
}

type FinopsGate = { evaluation: StartBudgetEvaluation; approval: any | null; normalApproval?: NormalApprovalRequest };

interface NormalPlanContext {
  spent: SpentSoFar;
  month: { spent: string; outstanding: string; total: string };
  plan: NormalApprovalPlan;
}

export function budgetBlockedConflict(blockedBy: NormalApprovalPlan['blockedBy'], preview?: unknown): ConflictException {
  const b = blockedBy.map((x) => `${x.limit}(${x.over === 'max' ? 'máximo' : 'esperado'}=${x.expected}, gastado=${x.spent}, límite=${x.limitValue ?? '—'})`).join(', ');
  return new ConflictException({
    code: BUDGET_BLOCKED,
    message: `${BUDGET_BLOCKED}: el estimado supera la política de presupuesto: ${b}. No se creó nada.`,
    blockedBy,
    ...(preview ? { preview } : {}),
  });
}
export const APPROVAL_FORBIDDEN = 'approval_forbidden';
/**
 * EV6 DoD (BE-A): «Generar videos reales» (vista previa + confirmación), cancelar un upgrade en
 * vuelo y el reenvío pago de un video fallido son herramientas de RECUPERACIÓN de admin
 * (SUPER_ADMIN): 403 a cualquier otro usuario, dueño incluido. Los reintentos sin gasto siguen
 * disponibles para el dueño.
 */
export const ADMIN_RECOVERY_ONLY = 'admin_recovery_only';

/**
 * Fix round 1 (C2): ¿el item video ya intentó un render PAGADO en Videogen? (envío iniciado, job
 * registrado o archivado, o un error que solo ocurre después de enviar). Un video que nunca llegó a
 * enviarse (bloqueado por dependencia o presupuesto, falla previa al envío) devuelve false.
 */
export function videoRenderWasAttempted(r: { error?: string | null; output_summary?: Record<string, any> | null }): boolean {
  const os = r.output_summary ?? {};
  const err = String(r.error ?? '');
  return !!os.externalSubmitStartedAt || !!os.external?.videogenJobId ||
    (Array.isArray(os.previousExternals) && os.previousExternals.length > 0) ||
    /^(videogen_failed|videogen_submit_rejected|ambiguous_video_submission)/.test(err) || err.includes(PROVIDER_RECONCILIATION_REQUIRED);
}

function adminRecoveryForbidden(what: string): ForbiddenException {
  return new ForbiddenException({
    code: ADMIN_RECOVERY_ONLY,
    message: `${ADMIN_RECOVERY_ONLY}: ${what} es una herramienta de recuperación de un administrador de Cursia. No se hizo nada.`,
  });
}

export interface StartPreview {
  manifestId: number;
  blueprintNumber: number;
  rulesVersion: number;
  counts: PreviewCounts;
  existingRun: { id: string; status: string; active: boolean } | null;
  estimate: {
    currency: string; min: string; expected: string; max: string;
    byProvider: Record<string, MinExpMax>; byItemType: Record<string, MinExpMax>; byCategory: Record<string, MinExpMax>;
    /** V542: banco de preguntas de los exámenes y reserva por reintentos (incluidos en expected/max). */
    breakdown: EstimateBreakdown;
  } | null;
  decision: string | null;
  reasons: string[];
  paidRealProviders: string[];
  approval: {
    required: boolean; canApprove: boolean; withinPolicy: boolean; amount: string | null;
    cappedByLimit: string | null; blockedBy: NormalApprovalPlan['blockedBy'];
    /** Aprobación de admin vigente sin consumir que ya cubre el esperado (startRun la usa). */
    existing: { amount: string } | null;
  } | null;
  policy: { maxCostPerRun: string | null; maxCostPerCourse: string | null; monthlyCap: string | null; courseSpent: string; monthSpent: string } | null;
  estimateHash: string | null;
  /** Internos (no viajan al cliente: ver publicPreview). */
  _plan?: NormalApprovalPlan;
  _evaluation?: StartBudgetEvaluation;
}

export interface PreviewCounts {
  modules: number;
  chapters: number;
  presentations: number;
  videos: number;
  activities: number;
  moduleExams: number;
  finalExam: boolean;
  audiobookChapters: number;
  audioWelcome: boolean;
}

/** Conteos visibles desde los items del Manifest (lo que realmente se generaría). */
export function previewCounts(manifest: { manifest: { items: ReadonlyArray<{ type: string; moduleId?: string | null; chapterId?: string | null }> } }): PreviewCounts {
  const items = (manifest.manifest && manifest.manifest.items) || [];
  const mods = new Set<string>();
  const chs = new Set<string>();
  const n = (t: string) => items.filter((i) => i.type === t).length;
  for (const i of items) {
    if (i.moduleId) mods.add(i.moduleId);
    if (i.chapterId) chs.add(i.chapterId);
  }
  return {
    modules: mods.size,
    chapters: chs.size,
    presentations: n('presentation'),
    videos: n('video'),
    activities: n('activity') + n('scorm'),
    moduleExams: n('exam'),
    finalExam: n('final_exam') > 0,
    audiobookChapters: n('audiobook_chapter'),
    audioWelcome: n('audio_welcome') > 0,
  };
}

/** Preview sin los campos internos. */
export function publicPreview(pv: StartPreview): Omit<StartPreview, '_plan' | '_evaluation'> {
  const { _plan, _evaluation, ...rest } = pv;
  return rest;
}

// ── EV6 T5 B2: «Generar videos reales» ──────────────────────────────────────

export interface VideoUpgradePreview {
  runId: string;
  rulesVersion: number;
  /** true = se puede confirmar (sin trabas y con videos pendientes); la aprobación se ve en `approval`. */
  eligible: boolean;
  pendingVideos: Array<{ itemKey: string; chapterId: string | null; generation: number; reusesVideogenJob?: boolean }>;
  interactions: Array<{ itemKey: string; generation: number }>;
  estimate: {
    currency: string; min: string; expected: string; max: string;
    byProvider: Record<string, MinExpMax>; byItemType: Record<string, MinExpMax>; byCategory: Record<string, MinExpMax>;
    /** V542: banco de preguntas de los exámenes y reserva por reintentos (incluidos en expected/max). */
    breakdown: EstimateBreakdown;
  } | null;
  approval: {
    required: boolean; canApprove: boolean; withinPolicy: boolean; amount: string | null;
    cappedByLimit: string | null; blockedBy: NormalApprovalPlan['blockedBy']; existing: { amount: string } | null;
  } | null;
  blockers: Array<{ code: string; message: string }>;
  /** Huella del estimado: la confirmación la exige igual (si no → 409 estimate_stale). */
  estimateHash: string | null;
  /** I-3: preguntas de videos reales ya pagados que faltan (solo LLM, sin costo de video). */
  questionsOnly?: Array<{ videoItemKey: string; itemKey: string; generation: number }>;
  /** m-8: videos con un envío a Videogen ambiguo (fuera del upgrade; requieren revisión del equipo). */
  needsReconciliation?: Array<{ itemKey: string; chapterId: string | null }>;
  /** Último upgrade del run (informativo). */
  upgrade: VideoUpgradeRecord | null;
  /** true = el último upgrade todavía tiene videos/preguntas en vuelo: no hay nada que confirmar. */
  upgradeInFlight: boolean;
  /** Interno (no viaja al cliente). */
  _blockers?: VideoUpgradeBlocker[];
}

export interface VideoUpgradeResult {
  /** true = se creó el upgrade (201); false = ya existía (200, mismo upgrade, nada escrito). */
  created: boolean;
  upgrade: VideoUpgradeRecord;
  run: RunDto;
}

interface VideoUpgradeBlocker {
  code: string;
  message: string;
  error: () => Error;
}

interface VideoUpgradePlan {
  pending: any[];
  interactions: any[];
  blockers: VideoUpgradeBlocker[];
  /** Pendientes cuyo intento anterior ya tiene un job REAL en Videogen (se reutiliza, sin gasto nuevo). */
  carried: any[];
  /** I-3: videos reales del upgrade (ya pagados) a los que solo les faltan SUS preguntas (LLM). */
  questionsOnly: Array<{ video: any; interactions: any }>;
  /** m-8: videos cuyo envío a Videogen quedó ambiguo: fuera del upgrade, requieren revisión. */
  needsReconciliation: any[];
}

interface VideoUpgradeEconomics {
  estimate: EstimateResult;
  plan: NormalApprovalPlan;
  policyId: string | null;
  runActual: string;
  estimateHash: string;
}

export function publicVideoUpgradePreview(pv: VideoUpgradePreview): Omit<VideoUpgradePreview, '_blockers'> {
  const { _blockers, ...rest } = pv;
  return rest;
}

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  /** EV6 DoD BE-B: oyentes de «el run pasó a completed» (después del commit; empaque automático). */
  private readonly runCompletedListeners: Array<(runId: string) => unknown> = [];
  private readonly pendingRunCompletedHooks = new Set<Promise<unknown>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
    private readonly costRates: CostRatesService,
    /**
     * DN-1: preflight de YouTube (gate de runs reales con video). @Optional:
     * si falta (harness sin el módulo), todo camino que lo necesite falla
     * CERRADO con 409 `youtube_preflight_failed:preflight_unavailable`.
     */
    @Optional() private readonly youtubePreflight?: DynamicYoutubePreflightService,
    /**
     * V2.1 RF-b: estimado + gates de presupuesto. @Optional por los harnesses
     * previos: sin él, todo camino con un proveedor pagado REAL falla CERRADO
     * (503 finops_unavailable); los runs mock/LLM siguen sin estimado.
     */
    @Optional() private readonly finopsBudget?: FinopsBudgetService,
  ) {
    // M6 (review-it2): NO se valida DYNAMIC_VIDEO_DELIVERY acá. RunsService
    // vive en AppModule, que arranca la API y todos los workers legacy — un
    // typo tumbaría todo. La validación (ruidosa, sin fallback) es lazy: en
    // startRun (creación del run) y, como log de arranque, en los workers
    // dynamic (reportVideoDeliveryConfigAtStartup).
  }

  /**
   * Get-or-create (y reapertura) del run de un Manifest.
   *
   * - Run ACTIVO: se devuelve (`created:false`); su contexto NO cambia nunca
   *   (condición §7.2) — si el contexto enviado tiene otro hash → 409 con el
   *   runId.
   * - Sin activo, último run TERMINADO en cancelled/failed (R10): con el MISMO
   *   hash de contexto se REABRE (items cancelled → pending, o blocked si
   *   alguna dependencia está failed; failed/completed intactos; mismas filas
   *   e idempotency keys) → `{created:false, reopened:true}`. Con otro hash →
   *   409: cambiar el contexto es regeneración (Fase 8).
   * - Último run completed → 409 (re-ejecutar un Manifest completo es
   *   regeneración, generation 2 = Fase 8). Los items failed de un run se
   *   reintentan con `retryItem`.
   * - Sin runs → se crea (job + contexto + items en una transacción). La
   *   concurrencia la garantiza el índice único parcial: el perdedor de una
   *   carrera recibe 23505, re-selecciona el run activo y lo devuelve.
   * - I1 (review-rv2): si el CURSO ya tiene un run activo sobre OTRO Manifest
   *   (otra rulesVersion del mismo Blueprint, u otro Blueprint) → 409 con
   *   `runId=<activo>` (en el mensaje y en el body): nunca dos generaciones
   *   completas en paralelo. Garantizado bajo concurrencia por un advisory
   *   lock por curso en insertRun/reopenRun/retryItem.
   */
  async startRun(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    courseContext: CourseContextDto | FromRunDto,
    /** Flujo normal (approveAndStart): aprobación a escribir en la tx del run nuevo. */
    opts: { normalApproval?: NormalApprovalRequest } = {},
  ): Promise<StartRunResult> {
    // G3: flag V2 + allow-list por owner (403 antes de tocar la DB).
    assertDynamicOwnerAllowed(ownerId);
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    // V2.1 F1 (I3): v3 → el perfil de evaluación vigente debe resolverse contra este Manifest ANTES de gastar (409).
    await assertAssessmentProfileResolvableForRun(this.dataSource, courseId, manifest);
    // Fase 8 (F8-BE): `{fromRun}` crea el run B aplicando el plan de
    // invalidación (mismo entry point → mismos gates G3 de arriba).
    if (isFromRunRequest(courseContext)) {
      return this.startRunFromPrevious(courseId, ownerId, blueprintNumber, manifest, courseContext.fromRun);
    }
    const context = normalizeCourseContext(courseContext);
    this.assertRequiredContext(context);
    const contextHash = canonicalContextHash(context);
    const videoMode = this.normalizeVideoMode((courseContext as any)?.videoMode);
    // 5B.2.A: la estrategia de entrega se lee (y valida, fail-fast) en cada
    // uso y se congela SOLO en runs nuevos; un run existente/reabierto
    // conserva la suya aunque la config haya cambiado.
    const videoDelivery = readVideoDeliveryConfig();
    // V2.1 fix round 1 (I1/M1): modos de proveedor explícitos (v3; v1/v2 → undefined).
    const providerModes = this.providerModesForNewRun(manifest.rulesVersion, (courseContext as any)?.providerModes);
    // V2.1 F2 (review final I1/I2): preflight de proveedores v3 ANTES de cualquier escritura o gasto.
    if (providerModes) {
      const gate = resolveRunVideoDelivery({ videoCount: this.videoCountOf(manifest), videoMode, configured: videoDelivery });
      // Un gate de entrega inválido lo rechaza más abajo enforceVideoGate con su propio 409.
      this.assertV3ProviderPreflight(manifest, providerModes, videoMode, gate.ok ? gate.strategy : null);
    }
    // I1 (review-rv2): nunca dos generaciones completas activas del mismo
    // curso (doble gasto) — p.ej. un run v1 en curso y la config pasa a v2.
    // Chequeo temprano (409 legible); la garantía bajo concurrencia la dan
    // los chequeos bajo advisory lock en insertRun/reopenRun/retryItem.
    const other = await this.findActiveRunOnOtherManifest(this.dataSource, courseId, manifest.id);
    if (other) throw this.otherActiveRunConflict(other, manifest);
    return this.resolveOrCreateRun(courseId, ownerId, blueprintNumber, manifest, context, contextHash, videoMode, true, videoDelivery, providerModes, opts);
  }

  // ── Flujo NORMAL de aprobación desde la UI (separado de la calibración) ──

  /**
   * Estimado COMPLETO de lo que costaría iniciar la generación con este
   * contexto, más la decisión de presupuesto y si el usuario puede aprobarla
   * desde la UI. Solo lectura: no escribe estimados, aprobaciones ni runs, y
   * corre los gates previos a escribir de startRun para un run nuevo
   * (owner/flag, Manifest, perfil de evaluación, contexto, modos de proveedor,
   * worker de proveedores, preflight v3, otro run activo del curso, video
   * real habilitado). Con un run ya existente en este Manifest devuelve
   * `existingRun` (la UI lo retoma; no se re-estima). Sin FinOps: solo runs
   * sin proveedores pagados (mismo criterio que startRun).
   */
  async previewStart(
    courseId: number,
    user: { id: string; email?: string | null },
    blueprintNumber: number,
    courseContext: CourseContextDto,
  ): Promise<StartPreview> {
    const ownerId = user.id;
    assertDynamicOwnerAllowed(ownerId);
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    await assertAssessmentProfileResolvableForRun(this.dataSource, courseId, manifest);
    const context = normalizeCourseContext(courseContext);
    this.assertRequiredContext(context);
    const contextHash = canonicalContextHash(context);
    const videoMode = this.normalizeVideoMode((courseContext as any)?.videoMode);
    const providerModes = this.providerModesForNewRun(manifest.rulesVersion, (courseContext as any)?.providerModes);
    if (providerModes) {
      const gate = resolveRunVideoDelivery({ videoCount: this.videoCountOf(manifest), videoMode, configured: readVideoDeliveryConfig() });
      this.assertV3ProviderPreflight(manifest, providerModes, videoMode, gate.ok ? gate.strategy : null);
    }
    const counts = previewCounts(manifest);
    const base = { manifestId: manifest.id, blueprintNumber, rulesVersion: manifest.rulesVersion, counts };
    const empty = { estimate: null, decision: null, reasons: [], paidRealProviders: [], approval: null, policy: null, estimateHash: null };
    const latest = await this.findLatestRunRow(manifest.id);
    if (latest) {
      return { ...base, ...empty, existingRun: { id: latest.id, status: latest.worker_status, active: isActive(latest) } };
    }
    // Mismos 409/403 que startRun daría para un run nuevo, ANTES de ofrecer autorizar.
    const other = await this.findActiveRunOnOtherManifest(this.dataSource, courseId, manifest.id);
    if (other) throw this.otherActiveRunConflict(other, manifest);
    // Fix round 1 (I1): la elegibilidad de video real solo aplica si la estructura confirmada tiene videos.
    if (videoMode === 'real' && this.videoCountOf(manifest) > 0) assertRealVideoAllowed(ownerId);
    const modes = runSpendModes(videoMode, providerModes ?? null);
    if (!this.finopsBudget) {
      const paid = paidRealProviders(estimateItemsForRun(manifest.manifest.items, modes, null), modes);
      if (paid.length > 0) {
        throw new ServiceUnavailableException({
          code: FINOPS_UNAVAILABLE,
          message: `${FINOPS_UNAVAILABLE}: no se puede evaluar el presupuesto de un run con proveedores pagados reales (${paid.join(', ')}); no se creó nada.`,
        });
      }
      return { ...base, ...empty, existingRun: null };
    }
    let evaluation: StartBudgetEvaluation;
    let np: NormalPlanContext;
    let existing: any | null = null;
    try {
      evaluation = await this.finopsBudget.evaluateStart({ courseId, ownerId, mode: modes, items: manifest.manifest.items });
      np = await this.normalPlan(this.dataSource, courseId, ownerId, evaluation);
      if (evaluation.decision === 'ADMIN_APPROVAL') {
        existing = await this.finopsBudget.findUnconsumedApproval(courseId, manifest.id, evaluation.estimate.totals.expected);
      }
    } catch (err) {
      throw this.finopsUnavailable(err);
    }
    let plan = np.plan;
    if (evaluation.decision === 'BLOCK' && plan.withinPolicy) {
      // on_exceed=BLOCK: startRun lo rechaza sin salida por aprobación.
      plan = { ...plan, withinPolicy: false, amount: null, cappedByLimit: null,
        blockedBy: [{ limit: 'policy_block', limitValue: null, spent: normalizeDecimal(np.spent.course), expected: evaluation.estimate.totals.expected, over: 'expected' }] };
    }
    // Una aprobación de admin vigente para este Manifest ya cubre el esperado: startRun la consume (camino normal).
    const required = evaluation.decision !== 'AUTO_WITHIN_POLICY' && !existing;
    const canApprove = isSuperAdminEmail(user.email);
    const estimateHash = estimateFingerprint({
      courseId, manifestId: manifest.id, manifestSha: manifest.sha256, contextHash, modes, estimate: evaluation.estimate,
      policyId: evaluation.policyId, plan, courseSpent: normalizeDecimal(np.spent.course),
    });
    const sum = estimateSummary(evaluation.estimate);
    return {
      ...base,
      existingRun: null,
      estimate: {
        currency: sum.currency, min: sum.min, expected: sum.expected, max: sum.max,
        byProvider: sum.byProvider, byItemType: evaluation.estimate.totals.byItemType, byCategory: estimateCategories(sum.byProvider),
        breakdown: estimateBreakdown(evaluation.estimate),
      },
      decision: evaluation.decision,
      reasons: evaluation.reasons,
      paidRealProviders: evaluation.paidRealProviders,
      approval: {
        required,
        canApprove,
        withinPolicy: plan.withinPolicy,
        amount: plan.amount,
        cappedByLimit: plan.cappedByLimit,
        blockedBy: plan.blockedBy,
        existing: existing ? { amount: normalizeDecimal(existing.authorized_budget) } : null,
      },
      policy: { ...plan.limits, courseSpent: normalizeDecimal(np.spent.course), monthSpent: np.month.total },
      estimateHash,
      _plan: plan,
      _evaluation: evaluation,
    } as StartPreview;
  }

  /** Política + gasto del curso + comprometido del mes → plan de aprobación normal (sobre `runner`). */
  private async normalPlan(runner: { query: (sql: string, params?: any[]) => Promise<any> }, courseId: number, ownerId: string,
    evaluation: StartBudgetEvaluation): Promise<NormalPlanContext> {
    const policy = await this.finopsBudget!.policyFor(courseId, ownerId, runner);
    const spent = await this.finopsBudget!.spentSoFar(courseId, runner);
    const month = await this.finopsBudget!.monthCommitted(runner);
    const plan = planNormalApproval({
      estimate: evaluation.estimate, policy, courseSpent: spent.course, monthSpent: month.total, providerSpent: spent.byProvider,
    });
    return { spent, month, plan };
  }

  /**
   * «Autorizar y generar» (UI). Re-valida TODO server-side: rol (SuperAdmin por
   * SUPER_ADMIN_EMAILS, nunca lo que diga el cliente), ownership + Manifest
   * vigente y gates de un run nuevo (previewStart), estimado recalculado ahora
   * con la MISMA huella que vio el usuario (si el Blueprint/Manifest, el
   * contexto, los precios, la política o el gasto cambiaron → 409
   * estimate_stale), y el monto sale del plan de la política (nunca del
   * cliente). La aprobación se escribe DENTRO de la transacción que crea el
   * run (finopsBindRun), bajo el lock global del tope mensual y con el plan
   * recalculado ahí: o nacen juntos run + aprobación consumida, o no se
   * escribe nada (sin aprobaciones colgadas que otro start pueda consumir).
   */
  async approveAndStart(
    courseId: number,
    user: { id: string; email?: string | null },
    blueprintNumber: number,
    courseContext: CourseContextDto,
    estimateHash: string,
  ): Promise<StartRunResult & { approval: { authorizationId: string | null; amount: string | null } }> {
    const pv = await this.previewStart(courseId, user, blueprintNumber, courseContext);
    const none = { authorizationId: null, amount: null };
    // Run existente (se retoma / reabre por el camino normal) o sin FinOps (solo mock): sin aprobación nueva.
    if (pv.existingRun || !pv.estimate || !pv.approval) {
      return { ...(await this.startRun(courseId, user.id, blueprintNumber, courseContext)), approval: none };
    }
    if (pv.estimateHash !== estimateHash) {
      throw new ConflictException({
        code: ESTIMATE_STALE,
        message: `${ESTIMATE_STALE}: el costo estimado cambió desde que lo viste (estructura, datos, precios o gasto); revisa el estimado nuevo. No se creó nada.`,
        preview: publicPreview(pv),
      });
    }
    // AUTO o una aprobación de admin vigente: el camino normal (startRun la consume).
    if (!pv.approval.required) return { ...(await this.startRun(courseId, user.id, blueprintNumber, courseContext)), approval: none };
    if (!pv.approval.canApprove) {
      throw new ForbiddenException({
        code: APPROVAL_FORBIDDEN,
        message: `${APPROVAL_FORBIDDEN}: este curso requiere la autorización de un administrador (esperado USD ${pv.estimate.expected}, máximo USD ${pv.estimate.max}). No se creó nada.`,
      });
    }
    if (!pv.approval.withinPolicy) throw budgetBlockedConflict(pv.approval.blockedBy, publicPreview(pv));
    const na: NormalApprovalRequest = {
      approvedBy: String(user.email),
      fingerprint: estimateHash,
      amount: pv._plan!.amount!,
      expected: pv.estimate.expected,
      max: pv.estimate.max,
      result: null,
    };
    const started = await this.startRun(courseId, user.id, blueprintNumber, courseContext, { normalApproval: na });
    return { ...started, approval: na.result ?? none };
  }

  /** V2.1 fix round 1 (I1/M1): ProviderModeError → 403/400; v3 sin worker de proveedor → 501. */
  private providerModesForNewRun(rulesVersion: number, requested: unknown): ProviderModes | undefined {
    let modes: ProviderModes | undefined;
    try {
      modes = resolveProviderModes(rulesVersion, requested);
    } catch (err) {
      if (err instanceof ProviderModeError) {
        const body = { message: err.message, code: err.code };
        throw err.code === PROVIDER_MOCK_NOT_ALLOWED ? new ForbiddenException(body) : new BadRequestException(body);
      }
      throw err;
    }
    if (modes && !isProviderWorkerDeployed()) {
      throw new NotImplementedException({ message: providerWorkerNotDeployedMessage(), code: 'PROVIDER_WORKER_NOT_DEPLOYED' });
    }
    return modes;
  }

  /**
   * V2.1 F2 (review final I1/I2): un run v3 solo nace si puede terminar.
   * - cada proveedor congelado en `real` está cableado y configurado → si no,
   *   409 `provider_not_ready` con la lista de lo que falta (nombres, nunca valores);
   * - con videos, la entrega congelada es YouTube → si no, 409
   *   `v3_requires_youtube_delivery` (video_interactions necesita el id de YouTube).
   * Puro sobre el entorno actual; se llama antes de escribir nada. El gate de
   * presupuesto (RF) corre después, igual que antes.
   */
  private assertV3ProviderPreflight(
    manifest: ManifestDto,
    providerModes: ProviderModes,
    videoMode: RunVideoMode,
    frozenDelivery: VideoDeliveryStrategy | null,
    videoCount: number = this.videoCountOf(manifest),
  ): void {
    if (manifest.rulesVersion !== 3) return;
    const missing = providerReadinessMissing({ providerModes, videoMode, videoCount });
    if (missing.length > 0) {
      throw new ConflictException({ message: providerNotReadyMessage(missing), code: PROVIDER_NOT_READY, missing });
    }
    if (frozenDelivery !== null && !v3VideoDeliveryOk(videoCount, frozenDelivery)) {
      throw new ConflictException({
        message: v3RequiresYoutubeMessage(frozenDelivery),
        code: V3_REQUIRES_YOUTUBE_DELIVERY,
        videoCount,
        videoDelivery: frozenDelivery,
      });
    }
  }

  /**
   * Fase 8 (F8-BE, spec §4 paso 3): crea el run B sobre el Manifest destino
   * `manifest` (Mb, el de este Blueprint) aplicando en UNA transacción el plan
   * de invalidación calculado desde el run A (`fromRunId`):
   * - item runs de B pre-sembrados: `completed` (con carried_from_item_run_id)
   *   para REUSE/REVIEW/STALE_NO_AUTO, `pending` para GENERATE/REGENERATE;
   * - por cada item reutilizado, filas de artifact NUEVAS que apuntan a la
   *   MISMA storage_path inmutable (`metadata.carriedFrom`); STALE_NO_AUTO →
   *   la fila nueva queda `stale` (se empaqueta con aviso);
   * - artifacts de A: `stale` (REGENERATE/STALE_NO_AUTO) o `disabled`
   *   (SOFT_DISABLE) con su motivo en metadata — nunca se reescribe la ruta
   *   ni se borra una fila.
   * B hereda de A el contexto congelado, videoMode y videoDelivery (los
   * artifacts reutilizados se generaron con ellos).
   *
   * Idempotente: el mismo par (A, Mb) devuelve el mismo B (`created:false`).
   * Gates: G3 (allow-list) ya se aplicó en startRun; video real
   * (`assertRealVideoAllowed`) si B es 'real' y va a GENERAR/REGENERAR algún
   * video; 409 si hay otro run activo en el curso (incluido A) o si Mb ya
   * tiene un run que no sale de A.
   */
  private async startRunFromPrevious(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    manifestB: ManifestDto,
    fromRunId: string,
    youtubePreflightPassed = false,
  ): Promise<StartRunResult> {
    const [rowA] = await this.dataSource.query(
      `select * from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation' and course_id = $2 and owner_id = $3`,
      [fromRunId, courseId, ownerId],
    );
    if (!rowA) throw new NotFoundException(`La ejecución de origen ${fromRunId} no existe para el curso #${courseId}`);
    const bpNumberA = Number(rowA.input_payload?.blueprintNumber);
    const manifestA = await this.manifests.getById(courseId, ownerId, bpNumberA, Number(rowA.input_payload?.manifestId));
    // V2.1 (R5): v3 → v3 se calcula; mezclar rulesVersion 3 con 1/2 → 501 antes de leer Blueprints (fail loud).
    try {
      assertInvalidationRulesSupported(manifestA.rulesVersion, manifestB.rulesVersion);
    } catch (err) {
      throw new NotImplementedException({ code: INVALIDATION_V3_NOT_IMPLEMENTED, message: (err as Error).message });
    }
    if (manifestA.id === manifestB.id) {
      throw new ConflictException(
        `La ejecución ${fromRunId} ya es del Manifest #${manifestB.id}: no hay cambio de estructura que aplicar ` +
          '(los items fallidos se reintentan con retry). runId=' + fromRunId,
      );
    }
    const ctxA = await this.loadContextRow(rowA.id);
    const videoMode = this.videoModeOf(rowA);
    const videoDelivery = frozenVideoDeliveryOf(rowA.input_payload);
    // V2.1 F2 (review final I1): B hereda los modos congelados de A → mismo preflight antes de escribir nada.
    {
      const inherited = frozenProviderModesOf(rowA.input_payload);
      if (manifestB.rulesVersion === 3 && inherited) this.assertV3ProviderPreflight(manifestB, inherited, videoMode, videoDelivery);
    }
    const [bpA, bpB] = await Promise.all([
      this.manifests.blueprintOfForRules(courseId, ownerId, bpNumberA, manifestA.rulesVersion),
      this.manifests.blueprintOfForRules(courseId, ownerId, blueprintNumber, manifestB.rulesVersion),
    ]);
    const [course] = await this.dataSource.query(
      `select metadata->>'courseId' as frontend_course_id from public.courses where id = $1`,
      [courseId],
    );

    let outcome: { kind: 'existing' | 'created'; jobId: string };
    try {
      outcome = await this.tx(async (qr) => {
        await this.lockCourseRuns(qr, courseId);
        // Idempotencia: ¿Mb ya tiene un run? Si sale de A → es "el" B.
        const [existing] = await qr.query(
          `select id, input_payload from public.production_jobs
            where execution_mode = 'dynamic_generation' and input_payload->>'manifestId' = $1
            order by created_at desc, id desc limit 1`,
          [String(manifestB.id)],
        );
        if (existing) {
          if (existing.input_payload?.fromRunId === rowA.id) return { kind: 'existing' as const, jobId: existing.id as string };
          throw new ConflictException(
            `El Manifest #${manifestB.id} ya tiene una ejecución que no sale de ${rowA.id}; ` +
              `no se puede crear otra. runId=${existing.id}`,
          );
        }
        // Fix wave (review F78 M5, promovido): A ya reemplazado por otro B (otro
        // Manifest) → se aplica desde el más reciente, nunca desde A.
        const superseding = await this.findSupersedingRun(qr, rowA.id);
        if (superseding) throw this.supersededConflict(rowA.id, superseding);
        const other = await this.findActiveRunOnOtherManifest(qr, courseId, manifestB.id);
        if (other) throw this.otherActiveRunConflict(other, manifestB);

        const { plan } = await computePlanFromDb(qr, {
          runA: rowA,
          manifestA,
          blueprintA: bpA.snapshot,
          manifestB,
          blueprintB: bpB.snapshot,
          contextHash: ctxA.context_hash,
        });
        const fromArtifactIds = [...new Set(plan.actions.flatMap((a) => a.fromArtifactIds))];
        const srcRows: any[] = fromArtifactIds.length
          ? await qr.query(`select * from public.artifacts where id = any($1::uuid[]) for update`, [fromArtifactIds])
          : [];
        if (srcRows.length !== fromArtifactIds.length) {
          // Un artifact de A se borró entre el plan y el lock (fix wave I2): nunca
          // se aplica un plan sobre salida que ya no existe.
          throw new ConflictException(
            `Los artifacts de la ejecución ${rowA.id} cambiaron mientras se aplicaba el plan ` +
              `(${fromArtifactIds.length - srcRows.length} ya no existen); reintenta. runId=${rowA.id}`,
          );
        }
        const sources = new Map(srcRows.map((r) => [r.id, r]));
        const writes = planApplyWrites(
          plan,
          manifestB.manifest.items,
          bpA.snapshot,
          ctxA.context_hash,
          (id) => sources.get(id)?.status ?? null,
          (id) => sources.get(id)?.metadata?.inputFingerprint ?? null,
          { required: (t, variant, present) => requiredArtifactTypesForPresent(manifestB.rulesVersion, t as ManifestItemType, variant, present), typeOf: (id) => sources.get(id)?.type },
        );
        if (writes.missingRoles.length > 0) {
          const message =
            `No se puede reutilizar la salida de ${rowA.id} en el Manifest #${manifestB.id} (rulesVersion ` +
            `${manifestB.rulesVersion}): faltan roles de artifact obligatorios (${writes.missingRoles.length}) ` +
            `missingJson=${JSON.stringify(writes.missingRoles)}. Pasar a rulesVersion ${manifestB.rulesVersion} requiere una ` +
            'generación completa nueva (POST …/runs con el contexto del curso, sin fromRun).';
          throw new ConflictException({ message, code: 'reuse_missing_roles', missing: writes.missingRoles });
        }
        // Gate de video real (review 5C I1): B va a pagar Videogen solo si
        // GENERA/REGENERA algún video (STALE_NO_AUTO nunca regenera solo).
        if (videoMode === 'real' && writes.videoItemsToGenerate.length > 0) assertRealVideoAllowed(ownerId);
        // EV6 DoD (BE-A): B hereda el modo de A; generar videos NUEVOS de vista previa exige el escape de QA.
        if (videoMode === 'mock' && writes.videoItemsToGenerate.length > 0) assertVideoPreviewAllowed();
        // DN-1: B hereda la estrategia de A; si va a GENERAR videos reales,
        // entrega YouTube + preflight OK. El preflight hace red → se corre FUERA
        // de la tx (rollback: nada escrito) y se reintenta una sola vez.
        const gate = frozenRunVideoGate({ videoWork: writes.videoItemsToGenerate.length, videoMode, strategy: videoDelivery });
        if (gate.ok === false) throw new ConflictException({ message: gate.message, code: gate.code });
        if (gate.requiresYoutubePreflight && !youtubePreflightPassed) throw new NeedsYoutubePreflight(gate);
        // V2.1 fix round 1 (M1): B va a generar items de Gamma/TTS → el worker de proveedor tiene que existir.
        if (writes.providerItemsToGenerate.length > 0 && !isProviderWorkerDeployed()) {
          throw new NotImplementedException({ message: providerWorkerNotDeployedMessage(), code: 'PROVIDER_WORKER_NOT_DEPLOYED' });
        }

        // V2.1 RF-b: estimado del plan (REUSE = 0 incremental) + gate de presupuesto.
        const planActions: Record<string, string> = {};
        for (const a of plan.actions) if (a.inTargetManifest) planActions[a.itemKey] = a.action;
        const budget = await this.finopsEvaluate({
          courseId, ownerId, manifestId: manifestB.id, items: manifestB.manifest.items,
          modes: runSpendModes(videoMode, frozenProviderModesOf(rowA.input_payload)), actions: planActions,
          runner: qr, planSha: plan.planSha256,
        });

        const invalidation = { fromRunId: rowA.id, planSha256: plan.planSha256, totals: plan.totals, plan };
        const inputPayload = {
          manifestId: manifestB.id,
          blueprintNumber,
          contextHash: ctxA.context_hash,
          videoMode,
          videoDelivery,
          fromRunId: rowA.id,
          invalidationPlanSha256: plan.planSha256,
          // V2.1 fix round 1 (I1): B hereda los modos de proveedor congelados de A (v3).
          ...(rowA.input_payload?.providerModes ? { providerModes: rowA.input_payload.providerModes } : {}),
        };
        const [job] = await qr.query(
          `insert into public.production_jobs
             (owner_id, course_id, frontend_course_id, execution_mode, status, worker_status, current_step,
              progress, blueprint_version_id, input_payload, output_summary, options, result,
              lease_until, worker_id, created_at, updated_at)
           values ($1, $2, $3, 'dynamic_generation', 'queued', 'queued', 'dynamic_generation',
                   0, $4, $5::jsonb, $6::jsonb, '{}'::jsonb, '{}'::jsonb,
                   null, null, now(), now())
           returning id`,
          [ownerId, courseId, course?.frontend_course_id ?? null, manifestB.blueprintId, JSON.stringify(inputPayload),
            JSON.stringify({ invalidation })],
        );
        await qr.query(
          `insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash)
           values ($1, $2, $3::jsonb, $4)`,
          [job.id, manifestB.id, JSON.stringify(ctxA.context), ctxA.context_hash],
        );
        const seeded = await executeApplyWrites(qr, {
          jobB: job.id,
          runA: rowA.id,
          courseId,
          manifestB: { id: manifestB.id, blueprintId: manifestB.blueprintId },
          planSha256: plan.planSha256,
          writes,
          sourceArtifacts: sources,
          idempotencyKey: (key) => itemIdempotencyKey(manifestB.id, key, GENERATION),
        });
        if (seeded.size !== manifestB.totals.totalJobs) {
          throw new InternalServerErrorException(
            `Manifest #${manifestB.id}: se sembraron ${seeded.size} items pero totals.totalJobs = ${manifestB.totals.totalJobs}`,
          );
        }
        await this.finopsBindRun(qr, budget, { runId: job.id, courseId, ownerId, manifestId: manifestB.id, planSha: plan.planSha256 });
        // Todo reutilizado (p.ej. reorder puro) → el run nace completed.
        await recomputeRunStatus(qr, job.id);
        return { kind: 'created' as const, jobId: job.id as string };
      });
    } catch (err) {
      if (err instanceof BudgetGateRejection) {
        throw await this.budgetRejection(err.evaluation, err.code, { courseId, ownerId, manifestId: manifestB.id, planSha: err.planSha });
      }
      if (!(err instanceof NeedsYoutubePreflight) || youtubePreflightPassed) throw err;
      await this.enforceVideoGate(ownerId, err.gate); // 409 si no pasa
      return this.startRunFromPrevious(courseId, ownerId, blueprintNumber, manifestB, fromRunId, true);
    }

    const job = await this.loadJobById(outcome.jobId);
    const inv = job.output_summary?.invalidation;
    if (outcome.kind === 'created' && inv?.plan) await this.finopsRecordAvoidance(job, manifestB, inv.plan);
    return {
      created: outcome.kind === 'created',
      reopened: false,
      run: await this.buildRunDto(job, manifestB),
      invalidation: inv ? { fromRunId: inv.fromRunId, planSha256: inv.planSha256, totals: inv.totals } : undefined,
    };
  }

  /**
   * Cuerpo de startRun. `mayRetry`: carrera en la que otro POST commitea su
   * run (con items) entre nuestras lecturas y assertNoPreviousItems — en vez
   * de un 409 "terminada" engañoso, se re-resuelve UNA vez contra ese run.
   */
  private async resolveOrCreateRun(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    manifest: ManifestDto,
    context: Record<string, any>,
    contextHash: string,
    videoMode: RunVideoMode,
    mayRetry: boolean,
    videoDelivery: VideoDeliveryStrategy,
    providerModes?: ProviderModes,
    opts: { normalApproval?: NormalApprovalRequest } = {},
  ): Promise<StartRunResult> {
    const active = await this.findActiveRunRow(manifest.id);
    if (active) return this.existingRunOrConflict(active, manifest, contextHash, videoMode, providerModes);

    const latest = await this.findLatestRunRow(manifest.id);
    if (latest) {
      // Carrera: el run pudo commitearse entre las dos lecturas → es el activo.
      if (isActive(latest)) return this.existingRunOrConflict(latest, manifest, contextHash, videoMode, providerModes);
      if (!isReopenable(latest)) {
        throw new ConflictException(
          `La ejecución anterior de este Manifest ya terminó (${latest.worker_status}); re-ejecutar un Manifest ` +
            `completo es regeneración (Fase 8). runId=${latest.id}`,
        );
      }
      const ctx = await this.loadContextRow(latest.id);
      if (ctx.context_hash !== contextHash) {
        throw new ConflictException(
          `La ejecución anterior usó otro contexto; cambiar el contexto requiere regeneración (Fase 8). runId=${latest.id}`,
        );
      }
      const latestVideoMode = this.videoModeOf(latest);
      // EV6 T5 B2 fix round 1 (I-1): tras un upgrade de video, reanudar con el modo ORIGINAL no es un cambio de modo.
      const latestOriginal = videoUpgradeOf(latest.input_payload) ? latest.input_payload?.videoModeOriginal : undefined;
      if (latestVideoMode !== videoMode && latestOriginal !== videoMode) {
        throw new ConflictException(
          `La ejecución anterior usó otro modo de video (${latestVideoMode}); cambiarlo requiere regeneración ` +
            `(Fase 8). runId=${latest.id}`,
        );
      }
      if (providerModes && !sameProviderModes(frozenProviderModesOf(latest.input_payload), providerModes)) {
        throw new ConflictException({
          message: `La ejecución anterior usó otros modos de proveedor; cambiarlos requiere regeneración. runId=${latest.id}`,
          code: PROVIDER_MODES_CONFLICT,
        });
      }
      // I1 (5C): reabrir un run 'real' vuelve a gastar Videogen → allow-list DYNAMIC_REAL_VIDEO_OWNERS.
      if (latestVideoMode === 'real' && this.videoCountOf(manifest) > 0) assertRealVideoAllowed(ownerId);
      // Fix wave (M5): un run reemplazado por uno creado desde él no se reabre.
      const superseding = await this.findSupersedingRun(this.dataSource, latest.id);
      if (superseding) throw this.supersededConflict(latest.id, superseding);
      // DN-1: reabrir re-encola los items cancelled; si alguno es un video sin
      // job de Videogen (envío NUEVO), aplica el gate de entrega (YouTube +
      // preflight) ANTES de escribir nada.
      // EV6 T5 B2 (I-1): los videos de un upgrade cancelado NO se reabren (nunca se vuelve a pagar
      // por reanudar): quedan pendientes y se generan solo con un upgrade nuevo (vista previa + aprobación).
      const videoWork = await this.videoSubmissionsIfReopened(this.dataSource, latest.id, ['cancelled'], true);
      await this.enforceVideoGate(
        ownerId,
        frozenRunVideoGate({ videoWork, videoMode: latestVideoMode, strategy: frozenVideoDeliveryOf(latest.input_payload) }),
      );
      // RF-b fix I1: reabrir re-encola items cancelled; si alguno envía trabajo pagado
      // real nuevo (video sin job, item de proveedor) → aprobación ADMIN que lo cubra.
      {
        const cancelled: Array<{ item_key: string; type: string; output_summary: Record<string, any> | null }> = await this.dataSource.query(
          `select g.item_key, g.type, g.output_summary from public.generation_item_runs g
            where g.job_id = $1 and g.status = 'cancelled' and ${latestGenerationPredicate('g')}`,
          [latest.id],
        );
        const paidKeys = cancelled
          .filter((r) => !isUpgradeGeneration(r.output_summary))
          .filter((r) => paidProviderOfItemType(r.type) !== null && (r.type !== 'video' || !r.output_summary?.external?.videogenJobId))
          .map((r) => r.item_key);
        await this.finopsPaidWorkGate({ courseId, ownerId, manifest, job: latest, paidKeys });
      }
      return this.reopenRun(latest.id, manifest, contextHash);
    }

    // Respaldo: items generation 1 sin run visible no deberían existir (FK
    // cascade), pero nunca se siembra encima de items ajenos. Si aparecen es
    // casi siempre la carrera "otro POST commiteó entre nuestras lecturas":
    // si ahora hay un run visible, se re-resuelve contra él (una vez).
    if (mayRetry && (await this.hasPreviousItems(manifest)) && (await this.findLatestRunRow(manifest.id))) {
      return this.resolveOrCreateRun(courseId, ownerId, blueprintNumber, manifest, context, contextHash, videoMode, false, videoDelivery, providerModes, opts);
    }
    await this.assertNoPreviousItems(manifest);
    // I1 (5C): un run NUEVO con video real requiere DYNAMIC_REAL_VIDEO_OWNERS (fail closed). Un run
    // 'real' ya activo se devuelve arriba sin pasar por acá (reanudar no se bloquea).
    // Fix round 1 (I1): un curso SIN videos arranca para cualquier owner (no hay Videogen que gastar).
    if (videoMode === 'real' && this.videoCountOf(manifest) > 0) assertRealVideoAllowed(ownerId);
    // DN-1: ≥1 video + videoMode real → se congela 'youtube' (o videogen_direct
    // solo con el permiso de staging) y el preflight de YouTube tiene que pasar
    // en el servidor. Si no → 409 sin escribir nada ni llamar a Videogen.
    const gate = resolveRunVideoDelivery({ videoCount: this.videoCountOf(manifest), videoMode, configured: videoDelivery });
    await this.enforceVideoGate(ownerId, gate);
    const frozenDelivery: VideoDeliveryStrategy = gate.ok ? gate.strategy : videoDelivery;

    const [course] = await this.dataSource.query(
      `select metadata->>'courseId' as frontend_course_id from public.courses where id = $1`,
      [courseId],
    );
    const frontendCourseId: string | null = course?.frontend_course_id ?? null;

    // V2.1 RF-b: estimado + gate de presupuesto ANTES de escribir el run.
    const budget = await this.finopsStartGate({
      courseId, ownerId, manifestId: manifest.id, items: manifest.manifest.items, modes: runSpendModes(videoMode, providerModes ?? null),
      normalApproval: opts.normalApproval,
    });

    let jobId: string;
    try {
      jobId = await this.tx(async (qr) => {
        const id = await this.insertRun(qr, manifest, ownerId, courseId, frontendCourseId, blueprintNumber, context, contextHash, videoMode, frozenDelivery, providerModes);
        await this.finopsBindRun(qr, budget, { runId: id, courseId, ownerId, manifestId: manifest.id });
        return id;
      });
    } catch (err) {
      if (isActiveRunConflict(err)) {
        // Carrera: otro POST creó el run activo primero (y ya commiteó — el
        // índice único espera al otro insert antes de fallar).
        const winner = await this.findActiveRunRow(manifest.id);
        if (winner) return this.existingRunOrConflict(winner, manifest, contextHash, videoMode, providerModes);
        throw new ConflictException(
          `Otra ejecución del Manifest #${manifest.id} se creó y terminó mientras se procesaba esta; reintenta la consulta`,
        );
      }
      throw err;
    }

    return { created: true, reopened: false, run: await this.buildRunDto(await this.loadJobById(jobId), manifest) };
  }

  /**
   * R11: el run "actual" del Blueprint para que la UI reanude tras recargar
   * sin reenviar contexto: el activo si hay, si no el más reciente, si no
   * `null`.
   *
   * I1 (review-rv2): se busca entre TODOS los Manifests del Blueprint (v1 y
   * v2), no solo el de DYNAMIC_MANIFEST_RULES_VERSION — un run v1 en curso
   * sigue siendo "el actual" aunque la config pase a 2 (antes: 404 y la UI
   * creaba un run v2 en paralelo). Se responde con el Manifest congelado de
   * ESE run. Sin runs, se conserva el comportamiento de siempre contra el
   * Manifest configurado (mismos 404/400; `null` si existe y no tiene runs).
   */
  async getCurrentRun(courseId: number, ownerId: string, blueprintNumber: number, read?: RunReadOptions): Promise<RunDto | null> {
    const current = await this.findCurrentRunOfBlueprint(courseId, ownerId, blueprintNumber);
    if (!current) {
      await this.manifests.get(courseId, ownerId, blueprintNumber);
      return null;
    }
    return this.buildRunDto(current.job, current.manifest, read);
  }

  /**
   * I1: run actual del Blueprint entre todos sus Manifests (cualquier
   * rulesVersion): el activo (tras reconciliar cancels legacy) si hay, si no
   * el más reciente. Con su Manifest congelado, leído vía getById (verifica
   * dueño, `dynamic` y pertenencia al Blueprint → 404/400 de siempre).
   */
  private async findCurrentRunOfBlueprint(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
  ): Promise<{ job: any; manifest: ManifestDto } | null> {
    const rows = await this.dataSource.query(
      `select pj.* from public.production_jobs pj
         join public.course_generation_manifests m
           on m.id::text = pj.input_payload->>'manifestId' and m.course_id = pj.course_id
         join public.course_blueprints b on b.id = m.blueprint_id and b.course_id = m.course_id
        where pj.execution_mode = 'dynamic_generation'
          and pj.course_id = $1 and pj.owner_id = $2 and b.blueprint_number = $3
        order by pj.created_at desc, pj.id desc`,
      [courseId, ownerId, blueprintNumber],
    );
    if (rows.length === 0) return null;
    let chosen: any = null;
    for (const row of rows) {
      const r = await this.reconcileCancellation(row);
      if (isActive(r)) {
        chosen = r;
        break;
      }
    }
    if (!chosen) chosen = await this.reconcileCancellation(rows[0]);
    const manifest = await this.manifests.getById(courseId, ownerId, blueprintNumber, Number(chosen.input_payload?.manifestId));
    return { job: chosen, manifest };
  }

  /**
   * I1: run activo del MISMO curso sobre OTRO Manifest (otra rulesVersion u
   * otro Blueprint). Con un QueryRunner dentro de una transacción que ya tomó
   * el advisory lock del curso (lockCourseRuns), el resultado es estable
   * hasta el commit.
   */
  private async findActiveRunOnOtherManifest(
    q: { query: (sql: string, params?: any[]) => Promise<any> },
    courseId: number,
    manifestId: number,
  ): Promise<{ id: string; manifestId: number; blueprintNumber: number | null; rulesVersion: number | null } | null> {
    const [row] = await q.query(
      `select pj.id, pj.input_payload->>'manifestId' as manifest_id, m.rules_version, b.blueprint_number
         from public.production_jobs pj
         left join public.course_generation_manifests m on m.id::text = pj.input_payload->>'manifestId'
         left join public.course_blueprints b on b.id = m.blueprint_id
        where pj.execution_mode = 'dynamic_generation' and pj.course_id = $1
          and pj.input_payload->>'manifestId' is distinct from $2
          and pj.worker_status = any($3::text[])
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
        order by pj.created_at desc, pj.id desc
        limit 1`,
      [courseId, String(manifestId), ACTIVE_RUN_WORKER_STATUSES],
    );
    if (!row) return null;
    return {
      id: row.id,
      manifestId: Number(row.manifest_id),
      blueprintNumber: row.blueprint_number ?? null,
      rulesVersion: row.rules_version ?? null,
    };
  }

  private otherActiveRunConflict(
    other: { id: string; manifestId: number; blueprintNumber: number | null; rulesVersion: number | null },
    manifest: ManifestDto,
  ): ConflictException {
    const message =
      `Ya hay una generación en curso para este curso (Blueprint v${other.blueprintNumber ?? '?'}, ` +
      `rulesVersion ${other.rulesVersion ?? '?'}, Manifest #${other.manifestId}). No se puede iniciar otra ` +
      `(Manifest #${manifest.id}, rulesVersion ${manifest.rulesVersion}) mientras esa siga activa: ` +
      `reanudala o cancélala primero. runId=${other.id}`;
    return new ConflictException({
      message,
      code: 'active_run_on_other_manifest',
      runId: other.id,
      manifestId: other.manifestId,
      rulesVersion: other.rulesVersion,
    });
  }

  /**
   * Fix wave (review F78 M5): run creado con `{fromRun: runId}` (el B más
   * reciente). Si existe, `runId` quedó REEMPLAZADO: no se reintenta, no se
   * reabre y no se aplica otro plan desde él.
   */
  private async findSupersedingRun(q: { query: (sql: string, params?: any[]) => Promise<any> }, runId: string): Promise<string | null> {
    const [row] = await q.query(
      `select id from public.production_jobs
        where execution_mode = 'dynamic_generation' and input_payload->>'fromRunId' = $1
        order by created_at desc, id desc limit 1`,
      [runId],
    );
    return row?.id ?? null;
  }

  private supersededConflict(runId: string, supersedingId: string): ConflictException {
    return new ConflictException({
      message:
        `La ejecución ${runId} fue reemplazada por ${supersedingId} (creada desde ella al cambiar la estructura); ` +
        `sigue desde la más reciente. runId=${supersedingId}`,
      code: 'superseded_run',
      runId: supersedingId,
    });
  }

  /**
   * I1: serializa, por curso, toda operación que puede dejar un run ACTIVO
   * (crear, reabrir, reintentar con reapertura). Advisory lock de
   * transacción: se libera solo en commit/rollback. Siempre se toma PRIMERO
   * en la transacción (antes de cualquier FOR UPDATE) → sin ciclos de locks
   * con el scheduler, que nunca lo toma.
   */
  private async lockCourseRuns(qr: QueryRunner, courseId: number): Promise<void> {
    await qr.query(`select pg_advisory_xact_lock($1::int, $2::int)`, [COURSE_RUNS_LOCK_NS, courseId]);
  }

  /**
   * R17: estimación de costo de video del Manifest — videoCount/ids salen
   * SIEMPRE del Manifest (totals.videoCount + items type='video', en orden);
   * el costo es best-effort desde la tarifa configurada
   * (video_engine/video_generation/per_video en cost_rates) — si no hay
   * tarifa activa, null + nota explicando por qué (nunca un número
   * inventado). El costo REAL de un video real lo informa Videogen
   * (getVideoCost) recién cuando termina — esto es solo una estimación para
   * decidir si autorizar el modo 'real' (condición 7).
   */
  async estimateRun(courseId: number, ownerId: string, blueprintNumber: number): Promise<RunVideoEstimate> {
    // I1 (review-rv2): el Manifest del run actual del Blueprint (cualquier
    // rulesVersion); sin runs, el configurado (mismos 404/400 de siempre).
    const current = await this.findCurrentRunOfBlueprint(courseId, ownerId, blueprintNumber);
    const manifest = current ? current.manifest : await this.manifests.get(courseId, ownerId, blueprintNumber);
    const videoItems = manifest.manifest.items.filter((it) => it.type === 'video');
    if (videoItems.length !== manifest.totals.videoCount) {
      throw new InternalServerErrorException(
        `Manifest #${manifest.id}: ${videoItems.length} items type=video pero totals.videoCount=${manifest.totals.videoCount}`,
      );
    }
    const videoChapterIds = videoItems.map((it) => it.chapterId);
    const videoCount = manifest.totals.videoCount;

    const rate = await this.costRates.getActiveRate('video_engine', 'video_generation', null, 'per_video');
    if (!rate) {
      return {
        videoCount,
        videoChapterIds,
        estimatedVideoCostUsd: null,
        costSource: null,
        note: 'Sin tarifa activa configurada (cost_rates: video_engine/video_generation/per_video); ' +
          'no se puede estimar el costo. El costo real lo informa Videogen por video una vez generado.',
      };
    }
    const estimatedVideoCostUsd = videoCount * Number(rate.rateUsd);
    return {
      videoCount,
      videoChapterIds,
      estimatedVideoCostUsd,
      costSource: rate.source ?? 'configured_rate',
      note: `Estimado con la tarifa configurada (${rate.rateUsd} USD/video); es orientativo — el costo real de un ` +
        'video en modo real lo informa Videogen (getVideoCost) al completarse.',
    };
  }

  async getRun(courseId: number, ownerId: string, blueprintNumber: number, runId: string, read?: RunReadOptions): Promise<RunDto> {
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    const job = await this.loadRunRow(courseId, manifest, runId);
    return this.buildRunDto(job, manifest, read);
  }

  /**
   * Cancela el run: run → cancelled; items no terminales (pending, running,
   * retrying, blocked) → cancelled (un item `running` queda descartado: su
   * complete exigirá status='running'). completed/failed se conservan.
   * Idempotente sobre un run ya cancelado; 409 si el run ya está completed.
   */
  async cancelRun(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    runId: string,
    /** EV6 DoD (R5): quién cancela (cancelar un upgrade de videos en vuelo es solo de SUPER_ADMIN). */
    actor?: { id?: string | null; email?: string | null },
  ): Promise<RunDto> {
    // Fix round 1 (I2): un SUPER_ADMIN cancela sobre el run del dueño real del curso.
    const actorId = actor?.id ?? ownerId;
    ownerId = await this.ownerForActor(courseId, ownerId, actor);
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    const job = await this.loadRunRow(courseId, manifest, runId);
    if (videoUpgradeOf(job.input_payload) && isActive(job) && !isSuperAdminEmail(actor?.email) && (await this.upgradeInFlight(this.dataSource, job))) {
      throw adminRecoveryForbidden('Cancelar la generación de los videos reales');
    }

    await this.tx(async (qr) => {
      const [locked] = await qr.query(
        `select id, status, worker_status from public.production_jobs where id = $1 for update`,
        [job.id],
      );
      // EV6 DoD: `preview` también es terminal (no hay nada que cancelar).
      if (locked.worker_status === 'completed') {
        throw new ConflictException(`La ejecución ${job.id} ya está completada; no se puede cancelar`);
      }
      if (locked.worker_status === 'preview') {
        throw new ConflictException(`La ejecución ${job.id} ya terminó (vista previa); no se puede cancelar`);
      }
      await this.markRunCancelled(qr, job.id, actorId, 'user_cancelled');
      await this.cancelOpenItems(qr, job.id);
    });
    return this.buildRunDto(await this.loadJobById(job.id), manifest);
  }

  /**
   * Reintenta un item `failed` (solo `failed`; cualquier otro estado → 409):
   * - item → pending, `attempt_count` se conserva, `max_attempts =
   *   attempt_count + 3`, el error anterior queda en
   *   `output_summary.previousErrors` (error → NULL);
   * - sus dependientes transitivos en `blocked` cuyas dependencias ya no
   *   están failed/blocked → pending (un exam con OTRO content todavía
   *   failed sigue blocked);
   * - si el run había terminado (p.ej. failed), se reabre a 'queued'.
   * Un run cancelado no admite reintentos (409).
   *
   * R16 (#2): `auto` = reapertura del auto-healer (misma transacción, sin
   * controlador). Solo items `failed` (nunca bloqueos de presupuesto), la
   * política se re-evalúa BAJO LOCK (allow-list, tope de rondas, espera), el
   * gate de presupuesto se evalúa sin registrar estimados (insuficiente → 409
   * y el item queda para un humano), concede `policy.attemptsPerRound`
   * intentos y deja la ronda en output_summary.autoHeal + previousErrors.
   */
  async retryItem(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    runId: string,
    itemKey: string,
    resubmitVideo = false,
    resubmitProvider = false,
    auto?: {
      policy: AutoHealPolicy; now?: Date; safe?: boolean; ambiguousAudio?: boolean; maxUsd?: number;
      /** REL CREDIT: sonda del proveedor tras crédito/cuota agotados (canario) o reanudación del resto. */
      providerProbe?: { mode: 'canary' | 'resume'; provider: FailureProvider };
    },
    /** EV6 DoD (R5): quién reintenta (la recuperación PAGA de un video es solo de SUPER_ADMIN). */
    actor?: { id?: string | null; email?: string | null },
  ): Promise<ItemRunDto> {
    // #583 (decisión del usuario): el ÚNICO reenvío automático de un proveedor con resultado incierto es
    // el de AUDIO (`auto.ambiguousAudio`, con resubmitProvider), re-evaluado bajo lock con el ledger.
    if (auto?.ambiguousAudio && (!resubmitProvider || resubmitVideo || auto.safe)) {
      throw new BadRequestException('auto-heal: el reenvío de audio incierto solo va con resubmitProvider');
    }
    // EV6 DoD BE-B: el ÚNICO reenvío automático permitido es el reintento seguro (`auto.safe`) de un
    // rechazo DEFINITIVO de Videogen sin gasto (videogen_submit_rejected), re-evaluado bajo lock.
    if (auto?.providerProbe && (resubmitProvider || resubmitVideo || auto.safe || auto.ambiguousAudio)) {
      throw new BadRequestException('auto-heal: la sonda del proveedor nunca reenvía ni se combina con otro modo automático');
    }
    if (auto && ((resubmitProvider && !auto.ambiguousAudio) || (resubmitVideo && !auto.safe))) {
      throw new BadRequestException('auto-heal: nunca reenvía a un proveedor (resubmitVideo/resubmitProvider)');
    }
    // Fix round 1 (I2): un SUPER_ADMIN reintenta sobre el run del dueño real del curso (FinOps, YouTube
    // y ownership se evalúan contra ese dueño); queda registrado quién actuó.
    const actorId = actor?.id ?? ownerId;
    if (!auto && actor) ownerId = await this.ownerForActor(courseId, ownerId, actor);
    // G3 (fix wave / review I1): un retry es un entry point como cualquier
    // otro — requiere la allow-list de V2, antes de tocar manifest o run.
    assertDynamicOwnerAllowed(ownerId);
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    let job = await this.loadRunRow(courseId, manifest, runId);
    job = await this.reconcileCancellation(job);
    if (isCancelledLike(job)) {
      throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden reintentar items`);
    }

    // DN-1 (antes de la tx: el preflight hace red y nunca corre con locks
    // tomados). Un video de un run youtube en fase de SUBIDA se reintenta sin
    // gasto de Videogen (el worker solo re-sube); una subida AMBIGUA no se
    // reintenta a ciegas (409 → endpoint de resolución explícita); cualquier
    // otro retry que pueda enviar un video NUEVO a Videogen pasa por el gate.
    const frozenDelivery = frozenVideoDeliveryOf(job.input_payload);
    const preRows: Array<{ id: string; item_key: string; type: string; status: string; error: string | null; output_summary: Record<string, any> | null; depends_on: string[] | null }> =
      await this.dataSource.query(
        `select id, item_key, type, status, error, output_summary, depends_on from public.generation_item_runs g
          where g.job_id = $1 and ${latestGenerationPredicate('g')}`,
        [job.id],
      );
    const preTarget = preRows.find((i) => i.item_key === itemKey);
    if (auto && preTarget?.status !== 'failed') {
      throw new ConflictException({ message: `auto_heal_not_eligible: "${itemKey}" no está failed`, code: 'auto_heal_not_eligible' });
    }
    let uploadPhaseRetry = false;
    if (preTarget && (preTarget.status === 'failed' || isBudgetBlocked(preTarget))) {
      if (preTarget.type === 'video' && frozenDelivery === 'youtube' && !resubmitVideo) {
        if (isAmbiguousYoutubeUpload(preTarget)) {
          const message =
            `${YOUTUBE_UPLOAD_AMBIGUOUS}: la subida a YouTube de "${itemKey}" quedó sin confirmar (puede existir ya un video en el canal). ` +
            'No se re-sube a ciegas: confirma el video existente o autoriza una nueva subida con ' +
            'POST …/items/:itemKey/youtube-resolution {"action":"confirm_existing","youtubeVideoId":"…"} | {"action":"authorize_reupload"}.';
          throw new ConflictException({ message, code: YOUTUBE_UPLOAD_AMBIGUOUS });
        }
        uploadPhaseRetry = deliveryStateOrPending(preTarget.output_summary?.delivery) !== 'pending';
      }
      let videoWork = 0;
      if (preTarget.type === 'video') {
        videoWork = !uploadPhaseRetry && (resubmitVideo || !preTarget.output_summary?.external?.videogenJobId) ? 1 : 0;
      } else {
        videoWork = preRows.filter((i) => i.type === 'video' && i.status === 'blocked' && !i.output_summary?.external?.videogenJobId).length;
      }
      await this.enforceVideoGate(ownerId, frozenRunVideoGate({ videoWork, videoMode: this.videoModeOf(job), strategy: frozenDelivery }));
      // RF-b fix I1: un retry que puede ENVIAR trabajo pagado real nuevo (video sin
      // job / resubmitVideo, item de proveedor, o videos/proveedores bloqueados que
      // se desbloquean) exige una aprobación ADMIN que cubra el incremental.
      if (!uploadPhaseRetry) {
        const isPaid = (r: { type: string }) => paidProviderOfItemType(r.type) !== null;
        // R16 fix M1: igual que un video con su job persistido, una presentación con su generationId de Gamma
        // persistido solo se re-pollea (nunca reenvía sin resubmitProvider): no es trabajo pagado nuevo.
        const newPaid = (r: { type: string; output_summary: Record<string, any> | null }, resubmit: boolean) => {
          if (resubmit) return true;
          if (r.type === 'video') return !r.output_summary?.external?.videogenJobId;
          if (r.type === 'presentation') return !r.output_summary?.external?.gammaGenerationId;
          return true;
        };
        // DoD follow-up fix round 1 (m1): los items pagos que ESTE reintento desbloquea (dependentsToUnblock,
        // la misma función que hace el desbloqueo bajo lock): solo esas filas salen de `blocked`. Antes se
        // contaba cualquier item pago bloqueado del run, y un reintento gratis podía pedir aprobación de admin.
        const unblockIds = new Set(this.dependentsToUnblock(
          preRows.map((r) => ({ id: r.id, item_key: r.item_key, status: r.status as ItemRunStatus, depends_on: r.depends_on ?? [] })), itemKey,
        ).map(String));
        const paidItems = isPaid(preTarget)
          ? (newPaid(preTarget, resubmitVideo || resubmitProvider) ? [preTarget] : [])
          : preRows.filter((r) => unblockIds.has(String(r.id)) && r.status === 'blocked' && isPaid(r) && newPaid(r, false));
        // EV6 DoD (R5) + fix round 1 (C2): solo un reintento que vuelve a RENDERIZAR un video que ya
        // intentó un render pagado (reenvío explícito, render fallido/rechazado/ambiguo) es recuperación
        // de admin. Un video que nunca se envió (p.ej. bloqueado por una dependencia o por presupuesto)
        // sigue siendo del dueño: su primer render va por el gate de FinOps de siempre (presupuesto
        // aprobado). Re-poll, re-subida a YouTube e items no pagos: dueño.
        // DoD follow-up (n5): MISMA regla que el chequeo bajo lock (y que el espejo del frontend): el propio
        // video que se re-renderizaría, o un video que ESTE reintento desbloquea (dependentsToUnblock). Un
        // video bloqueado que este reintento no toca no lo vuelve recuperación de admin (antes: cualquier
        // video bloqueado del run con un render intentado le ocultaba al dueño un reintento gratis).
        if (!auto && this.videoModeOf(job) === 'real' && !isSuperAdminEmail(actor?.email)) {
          const reRender = (r: { type: string; error: string | null; output_summary: Record<string, any> | null }) =>
            r.type === 'video' && !r.output_summary?.external?.videogenJobId && videoRenderWasAttempted(r);
          if (resubmitVideo || reRender(preTarget) || preRows.some((r) => unblockIds.has(String(r.id)) && reRender(r))) {
            throw adminRecoveryForbidden('Volver a generar un video (con costo)');
          }
        }
        await this.finopsPaidWorkGate({ courseId, ownerId, manifest, job, paidKeys: paidItems.map((r) => r.item_key), dryRun: !!auto });
      }
    }

    const targetId = await this.tx(async (qr) => {
      // I1: lock del curso primero — este reintento puede reabrir el run.
      await this.lockCourseRuns(qr, courseId);
      const [locked] = await qr.query(
        `select id, status, worker_status from public.production_jobs where id = $1 for update`,
        [job.id],
      );
      if (isCancelledLike(locked)) {
        throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden reintentar items`);
      }
      // Fix wave (M5): reintentar en un run ya reemplazado (B creado desde él)
      // regeneraría —y podría pagar— salida que nadie va a usar.
      const superseding = await this.findSupersedingRun(qr, job.id);
      if (superseding) throw this.supersededConflict(job.id, superseding);
      if (!ACTIVE_RUN_WORKER_STATUSES.includes(String(locked.worker_status))) {
        // Reabrir este run con otro run del curso activo = dos generaciones
        // completas en paralelo (doble gasto) → 409 con el runId del activo.
        const other = await this.findActiveRunOnOtherManifest(qr, courseId, manifest.id);
        if (other) throw this.otherActiveRunConflict(other, manifest);
      }

      const items: Array<{
        id: string;
        item_key: string;
        status: ItemRunStatus;
        depends_on: string[];
        type: string;
        error: string | null;
        output_summary: Record<string, any> | null;
        finished_at: Date | null;
        updated_at: Date | null;
        failure_class: string | null;
        claimed_at: Date | null;
      }> = await qr.query(
        // F78-BE2: la generación VIGENTE de cada item (una regeneración
        // fallida se reintenta sobre su propia fila, nunca sobre la histórica).
        `select id, item_key, status, depends_on, type, error, output_summary, finished_at, updated_at, claimed_at,
                -- REL MVP: clase registrada (R2) sin depender de que la columna exista (esquema tolerado).
                to_jsonb(g)->>'failure_class' as failure_class
            from public.generation_item_runs g
            where g.job_id = $1 and ${latestGenerationPredicate('g')}
            order by id
            for update`,
        [job.id],
      );
      const target = items.find((i) => i.item_key === itemKey);
      if (!target) {
        throw new NotFoundException(`El item "${itemKey}" no existe en la ejecución ${job.id}`);
      }
      // V2.1 RF-b: un item `blocked` por presupuesto (budget_exceeded) se reanuda
      // igual que un failed, tras ampliar la autorización del run.
      if (target.status !== 'failed' && !isBudgetBlocked(target)) {
        throw new ConflictException(
          `Solo se puede reintentar un item en estado "failed" (o "blocked" por ${BUDGET_EXCEEDED}); "${itemKey}" está en "${target.status}"`,
        );
      }
      // R16 (#2): la política del auto-healer se re-evalúa con la fila bloqueada (otro barrido, un retry
      // manual o un fallo nuevo pudieron cambiarla entre la lectura y este lock).
      let autoMeta: { round: number; code: string; pendingUsd?: number | null; kind?: AutoHealKind; strategy?: string } | null = null;
      // REL CREDIT: estado de la sonda que deja esta reapertura (canario) — null = se borra (cualquier otra reapertura).
      let probeState: Record<string, any> | null = null;
      if (auto && auto.providerProbe) {
        // Misma decisión que el barrido, con TODAS las filas del run bloqueadas: un único canario por (run, proveedor),
        // su espera, el tope de ~24 h, el run no detenido por el usuario; la reanudación solo tras un canario OK.
        const now = auto.now ?? new Date();
        const pp = auto.providerProbe;
        const plan = providerProbeEnabled(auto.policy)
          ? planProviderProbes(items as ProviderProbeRow[], now, String(job.id)).find((x) => x.provider === pp.provider)
          : undefined;
        const ok = !!plan && (pp.mode === 'canary'
          ? plan.action === 'probe' && plan.canaryId === String(target.id)
          : plan.action === 'resume' && plan.waitingIds.includes(String(target.id)));
        if (!ok) {
          const reason = plan ? plan.action : providerProbeEnabled(auto.policy) ? 'not_waiting' : 'disabled';
          throw new ConflictException({ message: `auto_heal_not_eligible: "${itemKey}" (provider_probe ${pp.mode}: ${reason})`, code: 'auto_heal_not_eligible', reason });
        }
        // M1: solo el estado de la racha VIGENTE (uno de una racha vencida se ignora).
        const same = effectiveProbeStateOf(target as ProviderProbeRow, pp.provider, now);
        if (pp.mode === 'canary') {
          probeState = {
            provider: pp.provider,
            firstFailedAt: same?.firstFailedAt ?? plan!.streakStartAt?.toISOString() ?? now.toISOString(),
            runRound: plan!.round + 1,
            rounds: Math.max(0, Math.floor(Number(same?.rounds ?? 0)) || 0) + 1,
            canaryAt: now.toISOString(),
            lastProbeAt: now.toISOString(),
          };
        }
        autoMeta = { round: plan!.round + (pp.mode === 'canary' ? 1 : 0), code: pp.mode === 'canary' ? PROVIDER_PROBE_STRATEGY : PROVIDER_PROBE_RESUME_STRATEGY };
      } else if (auto && auto.ambiguousAudio) {
        // #583: misma decisión que el barrido, con la fila bloqueada y lo pendiente del ledger releído acá.
        const pending = await this.ambiguousAudioPending(qr, target.id, target.output_summary);
        const d = ambiguousAudioResubmitDecision(target, auto.now ?? new Date(), pending, auto.policy, auto.maxUsd ?? AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD);
        if (d.heal === false) {
          throw new ConflictException({ message: `auto_heal_not_eligible: "${itemKey}" (${d.reason})`, code: 'auto_heal_not_eligible', reason: d.reason });
        }
        autoMeta = { round: d.round, code: AMBIGUOUS_AUDIO_RESUBMIT_CODE, pendingUsd: d.pendingUsd };
      } else if (auto && auto.safe) {
        // BE-B: reintento automático seguro (una vez; solo rechazos probados sin gasto).
        const d = safeAutoRetryDecision(target, auto.now ?? new Date(), auto.policy);
        if (d.heal === false || d.rule.resubmitVideo !== resubmitVideo) {
          throw new ConflictException({ message: `auto_heal_not_eligible: "${itemKey}" (${d.heal === false ? d.reason : 'mode_mismatch'})`, code: 'auto_heal_not_eligible' });
        }
        autoMeta = { round: d.round, code: d.rule.code };
      } else if (auto) {
        const d = autoHealDecision(target, auto.now ?? new Date(), auto.policy);
        if (d.heal === false) {
          throw new ConflictException({ message: `auto_heal_not_eligible: "${itemKey}" (${d.reason})`, code: 'auto_heal_not_eligible' });
        }
        autoMeta = { round: d.round, code: d.rule.code, kind: d.kind, strategy: d.strategy };
      }

      // I1 (fix wave / review controller ruling: "un retry NO es un resume").
      // Un retry gasta Videogen de nuevo cuando: el item reintentado es de
      // tipo 'video', o pide resubmitVideo (implica tipo video), o el run
      // está TERMINADO y este retry lo va a reabrir (mismo gasto que reabrir
      // desde startRun, I1 original). Un retry de un item NO-video dentro de
      // un run 'real' ya ACTIVO no es gasto nuevo → no requiere la lista.
      // DN-1: un retry de SUBIDA a YouTube (render ya hecho) no gasta Videogen.
      if (
        this.videoModeOf(job) === 'real' &&
        !uploadPhaseRetry &&
        (target.type === 'video' || resubmitVideo || !isActive(locked)) &&
        // Fix round 1 (I1): sin videos en el Manifest no hay gasto de Videogen que proteger.
        this.videoCountOf(manifest) > 0
      ) {
        assertRealVideoAllowed(ownerId);
      }
      // Fix round 3 (N5): el gate de recuperación de admin se re-evalúa sobre las filas BLOQUEADAS (un cambio
      // entre la lectura previa y el lock no puede colar un re-render pago de un no admin).
      if (!auto && this.videoModeOf(job) === 'real' && !isSuperAdminEmail(actor?.email) && !uploadPhaseRetry) {
        const reRender = (r: { type: string; error: string | null; output_summary: Record<string, any> | null }) =>
          r.type === 'video' && !r.output_summary?.external?.videogenJobId && videoRenderWasAttempted(r);
        const unblockKeys = new Set(this.dependentsToUnblock(items, itemKey).map(String));
        if (resubmitVideo || reRender(target) || items.some((i) => unblockKeys.has(String(i.id)) && reRender(i))) {
          throw adminRecoveryForbidden('Volver a generar un video (con costo)');
        }
      }

      // I4/R23: resubmitVideo solo para items type='video' en 'failed' cuyo
      // último error sea 'videogen_failed' (job terminal, no hay video → no
      // es un segundo video) o 'ambiguous_video_submission' (requiere
      // confirmación explícita del usuario en la UI). Mueve external/
      // externalSubmitStartedAt a output_summary.previousExternals[] antes
      // del retry normal, para que el worker someta de nuevo en vez de
      // reutilizar/quedar envenenado por el marcador anterior.
      let resubmitSetSql = '';
      // V2.1 F2 fix round 1: reenvío EXPLÍCITO de una generación de Gamma cuyo envío quedó ambiguo o falló
      // en Gamma. Archiva el id/marcador (su reserva pendiente sigue en el ledger) y el worker pide una nueva.
      if (resubmitProvider) {
        if (resubmitVideo) throw new BadRequestException('resubmitVideo y resubmitProvider son excluyentes');
        // Calibración #2: también los items de audio (OpenAI TTS / guion LLM) en reconciliación.
        if (!['presentation', 'audio_welcome', 'audiobook_chapter'].includes(target.type)) {
          throw new BadRequestException(`resubmitProvider solo aplica a items type="presentation" | "audio_welcome" | "audiobook_chapter"; "${itemKey}" es "${target.type}"`);
        }
        const err = target.error ?? '';
        const eligible = target.type === 'presentation'
          ? err.startsWith('gamma_submit_ambiguous') || err.startsWith('gamma_generation_failed') || err.startsWith(PROVIDER_RECONCILIATION_REQUIRED)
          : err.startsWith(PROVIDER_RECONCILIATION_REQUIRED);
        if (!eligible) {
          throw new BadRequestException(
            `resubmitProvider solo aplica cuando el último error es "gamma_submit_ambiguous", "gamma_generation_failed" o "${PROVIDER_RECONCILIATION_REQUIRED}"; "${itemKey}" falló con "${err}"`,
          );
        }
        this.logger.warn(`retryItem: resubmitProvider=true para "${itemKey}" (run ${job.id}) — error previo "${err}"; archivando la generación anterior`);
        // R16 fix M3: el reenvío empieza una espera nueva (tope de reloj de los timeouts gratuitos).
        resubmitSetSql = ` - 'external' - 'externalSubmitStartedAt' - 'externalReservationKey' - 'gammaPollSince' - 'videoPollSince'`;
      }
      if (resubmitVideo) {
        if (target.type !== 'video') {
          throw new BadRequestException(`resubmitVideo solo aplica a items type="video"; "${itemKey}" es "${target.type}"`);
        }
        const err = target.error ?? '';
        const eligible = err.startsWith('videogen_failed') || err.startsWith('ambiguous_video_submission')
          || err.startsWith('videogen_submit_rejected') || err.startsWith(PROVIDER_RECONCILIATION_REQUIRED);
        if (!eligible) {
          throw new BadRequestException(
            `resubmitVideo solo aplica cuando el último error es "videogen_failed", "ambiguous_video_submission", "videogen_submit_rejected" o "${PROVIDER_RECONCILIATION_REQUIRED}"; "${itemKey}" falló con "${err}"`,
          );
        }
        this.logger.warn(
          `retryItem: resubmitVideo=true para item "${itemKey}" (run ${job.id}) — error previo "${err}"; ` +
            'archivando external/externalSubmitStartedAt en previousExternals y sometiendo un video nuevo',
        );
        // R16 fix M3: el reenvío empieza una espera nueva (tope de reloj de los timeouts gratuitos).
        resubmitSetSql = ` - 'external' - 'externalSubmitStartedAt' - 'externalReservationKey' - 'gammaPollSince' - 'videoPollSince'`;
      }

      // REL CREDIT: toda reapertura borra el estado de la sonda (racha nueva); el canario lo vuelve a escribir abajo.
      const previousErrorsExpr = `(coalesce(output_summary, '{}'::jsonb) - '${PROVIDER_PROBE_KEY}') || jsonb_build_object(
                    'previousErrors',
                    coalesce(output_summary->'previousErrors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                      'error', error,
                      'attemptCount', attempt_count,
                      'maxAttempts', max_attempts,
                      'retriedAt', now()
                    ) || $3::jsonb)
                  )`;
      const outputSummaryExpr = resubmitVideo || resubmitProvider
        ? `((${previousErrorsExpr}) || jsonb_build_object(
                    'previousExternals',
                    coalesce(output_summary->'previousExternals', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                      'external', output_summary->'external',
                      'externalSubmitStartedAt', output_summary->'externalSubmitStartedAt',
                      'externalReservationKey', output_summary->'externalReservationKey',
                      'reason', error,
                      'archivedAt', now()
                    )),
                    -- Calibración #2: decisión humana explícita → las operaciones pagadas de los
                    -- intentos hasta acá quedan reconocidas (el worker ya no las trata como ambiguas).
                    -- BE-B: el reintento automático seguro NO reconoce nada (no es una decisión humana):
                    -- conserva el valor previo; su reserva rechazada ya está liquidada (no bloquea).
                    -- #583: el reenvío automático de AUDIO incierto sí reconoce (como «Resolver cobro»): su reserva
                    -- pendiente queda en el ledger contada como gasto y el próximo intento puede llamar.
                    'reconciliationAcknowledgedThroughAttempt', ${auto && !auto.ambiguousAudio ? `coalesce(output_summary->'reconciliationAcknowledgedThroughAttempt', '0'::jsonb)` : 'attempt_count'}
                  ) || $4::jsonb)${resubmitSetSql}`
        : `(${previousErrorsExpr}) || $4::jsonb`;
      // R16 (#2): la reapertura automática queda registrada (auditoría) en la misma escritura.
      const nowIso = (auto?.now ?? new Date()).toISOString();
      const entryExtra = autoMeta && auto?.providerProbe
        ? { auto: true, providerProbe: auto.providerProbe.mode, provider: auto.providerProbe.provider, providerProbeRound: autoMeta.round }
        : autoMeta && auto?.ambiguousAudio
        ? { auto: true, ambiguousAudioResubmit: true, ambiguousAudioResubmitRound: autoMeta.round, autoHealCode: autoMeta.code, pendingUsd: autoMeta.pendingUsd ?? null }
        : autoMeta && auto?.safe
        ? { auto: true, safeAutoRetry: true, safeAutoRetryRound: autoMeta.round, autoHealCode: autoMeta.code }
        : autoMeta
          ? { auto: true, autoHealRound: autoMeta.round, autoHealCode: autoMeta.code,
              ...(auto?.policy.classAware ? { autoHealClass: autoMeta.kind, autoHealStrategy: autoMeta.strategy } : {}) }
          : actorId !== ownerId ? { retriedBy: actorId } : {};
      const topExtra = autoMeta && auto?.providerProbe
        ? (probeState ? { [PROVIDER_PROBE_KEY]: probeState } : {})
        : autoMeta && auto?.ambiguousAudio
        ? { ambiguousAudioResubmit: { rounds: autoMeta.round, lastAt: nowIso, pendingUsd: autoMeta.pendingUsd ?? null,
            maxUsd: auto.maxUsd ?? AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD, maxRounds: AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS } }
        : autoMeta && auto?.safe
        ? { safeAutoRetry: { rounds: autoMeta.round, lastAt: nowIso, lastCode: autoMeta.code, maxRounds: SAFE_AUTO_RETRY_MAX_ROUNDS } }
        : autoMeta
          ? (auto!.policy.classAware
            // REL MVP: rondas A (reintento) y B (regeneración) por separado; cada una conserva la otra.
            ? { autoHeal: {
                rounds: autoMeta.kind === 'B' ? autoHealRoundsOf(target.output_summary) : autoMeta.round,
                regenRounds: autoMeta.kind === 'B' ? autoMeta.round : autoRegenRoundsOf(target.output_summary),
                lastAt: nowIso, lastCode: autoMeta.code, lastClass: autoMeta.kind, lastStrategy: autoMeta.strategy,
                maxRounds: autoHealMaxRoundsFor(target.type, auto!.policy), regenMaxRounds: auto!.policy.regenMaxRounds ?? 0 } }
            : { autoHeal: { rounds: autoMeta.round, lastAt: nowIso, lastCode: autoMeta.code, maxRounds: autoHealMaxRoundsFor(target.type, auto!.policy) } })
          : {};
      // BE-B: el reintento seguro concede UN intento (un único reenvío; si vuelve a fallar, humano).
      // #583: el reenvío de audio incierto también concede UN intento (un único reenvío).
      // REL CREDIT: el canario concede UN intento (una sola llamada de prueba; fuera de las rondas del auto-healer).
      const attemptsGranted = auto?.safe || auto?.ambiguousAudio || auto?.providerProbe?.mode === 'canary'
        ? 1 : auto ? Math.max(1, Math.floor(auto.policy.attemptsPerRound)) : 3;

      const updated = returningRows(
        await qr.query(
          `update public.generation_item_runs
              set status = 'pending',
                  max_attempts = attempt_count + $2::int,
                  -- REL MVP: cualquier reapertura olvida la marca «no elegible» del error anterior.
                  output_summary = (${outputSummaryExpr}) #- '{autoHeal,ineligibleMd5}',
                  error = null,
                  next_retry_at = null,
                  worker_id = null,
                  lease_until = null,
                  finished_at = null,
                  updated_at = now()
            where id = $1 and status = 'failed'
               or (id = $1 and status = 'blocked' and error like '${BUDGET_EXCEEDED}%')
            returning id`,
          [target.id, attemptsGranted, JSON.stringify(entryExtra), JSON.stringify(topExtra)],
        ),
      );
      if (updated.length !== 1) {
        throw new InternalServerErrorException(`No se pudo reabrir el item "${itemKey}" (fila no actualizada)`);
      }
      // REL R2: la reapertura queda en el log de intentos (misma transacción; no-op sin esquema).
      await recordItemReopened(qr, target.id, {
        actor: auto ? 'auto_heal' : isSuperAdminEmail(actor?.email) ? adminActor(actor?.email) : actorId !== ownerId ? adminActor(actorId) : 'owner',
        // REL MVP: con la política por clase la estrategia aplicada queda en el log (A reintento / B regenerar).
        strategy: auto?.providerProbe ? (auto.providerProbe.mode === 'canary' ? PROVIDER_PROBE_STRATEGY : PROVIDER_PROBE_RESUME_STRATEGY)
          : auto?.ambiguousAudio ? 'ambiguous_audio_resubmit' : auto?.safe ? 'safe_auto_retry'
          : auto && auto.policy.classAware && autoMeta?.strategy ? `auto_heal_${autoMeta.kind === 'B' ? 'regenerate' : 'retry'}:${autoMeta.strategy}`
          : auto ? 'auto_heal'
          : resubmitVideo ? 'manual_resubmit_video' : resubmitProvider ? 'manual_resubmit_provider' : 'manual_retry',
        automatic: !!auto,
      });

      const toUnblock = this.dependentsToUnblock(items, itemKey);
      if (toUnblock.length > 0) {
        const unblocked = returningRows(
          await qr.query(
            `update public.generation_item_runs
                set status = 'pending', finished_at = null, updated_at = now()
              where id = any($1::uuid[]) and status = 'blocked'
              returning id`,
            [toUnblock],
          ),
        );
        if (unblocked.length !== toUnblock.length) {
          throw new InternalServerErrorException(
            `Desbloqueo inconsistente de dependientes de "${itemKey}" (${unblocked.length}/${toUnblock.length})`,
          );
        }
      }

      if (!ACTIVE_RUN_WORKER_STATUSES.includes(String(locked.worker_status))) {
        // Reabre el run (queued). Si otro run del mismo Manifest estuviera
        // activo, el índice único parcial lo rechaza → 409 (y rollback de todo).
        try {
          await qr.query(
            `update public.production_jobs
                set status = 'queued', worker_status = 'queued', finished_at = null,
                    error_message = null, next_retry_at = null, updated_at = now()
              where id = $1`,
            [job.id],
          );
        } catch (err) {
          if (isActiveRunConflict(err)) {
            throw new ConflictException(
              `Ya hay otra ejecución activa para el Manifest #${manifest.id}; no se puede reabrir ${job.id}`,
            );
          }
          throw err;
        }
      }
      return target.id;
    });

    const [row] = await this.dataSource.query(`select * from public.generation_item_runs where id = $1`, [targetId]);
    return this.toItemDto(row, frozenDelivery);
  }

  /** R16 (#2): último motivo logueado por item (evita repetir el mismo "no se reabre" en cada barrido). */
  private readonly autoHealLastSkip = new Map<string, string>();

  /**
   * R16 (#2 + #16) — barrido del auto-healer (lo dispara el timer de la API,
   * ver auto-heal.ts/startAutoHealTimer). Lee sin locks los items `failed`
   * (generación vigente) y reabre los elegibles con retryItem(auto), que
   * re-evalúa todo bajo lock. Un item que no se puede reabrir (presupuesto,
   * run reemplazado, otro run activo, owner fuera de la allow-list…) se deja
   * para un humano, con un log por motivo.
   *
   * Fix round 1 (review I1/I2): el SQL ya filtra lo que el healer reabriría —
   * fallos RECIENTES (policy.maxAgeHours) de la ejecución VIGENTE del curso (sin
   * run ni Manifest más nuevos), allow/deny-list gruesa, precondición del id
   * del proveedor, tope de rondas por tipo y espera —, los más nuevos primero,
   * con paginación por clave (finished_at, id): filas no elegibles nunca tapan
   * a una elegible. Un log por barrido con los conteos.
   */
  async autoHealFailedItems(
    opts: { policy?: AutoHealPolicy; now?: Date; limit?: number; maxCandidates?: number } = {},
  ): Promise<AutoHealSweepResult> {
    const policy = opts.policy ?? autoHealPolicyFromEnv();
    const pageSize = Math.max(1, Math.floor(opts.limit ?? 50));
    const maxCandidates = Math.max(pageSize, Math.floor(opts.maxCandidates ?? 200));
    const now = opts.now ?? new Date();
    const result: AutoHealSweepResult = { candidates: 0, reopened: [], skipped: [] };
    // Fix m3: acotado antes del cast (un valor enorme en el jsonb no desborda ::int).
    const roundsSql = `least(floor(case when jsonb_typeof(g.output_summary->'autoHeal'->'rounds') = 'number'
                                  then (g.output_summary->'autoHeal'->>'rounds')::numeric else 0 end), 1000000)::int`;
    // Fix m1: cursor exacto al microsegundo (un Date de JS trunca a ms y podía saltear filas).
    const finishedUsSql = `(extract(epoch from g.finished_at) * 1000000)::bigint`;
    // REL MVP (política por clase): el SQL solo descarta lo seguro (deny-list, precondiciones, tope de rondas A,
    // la espera MÍNIMA posible con jitter, y los errores ya evaluados como no elegibles); la clase A/B, la espera
    // exacta y el tope de B los decide autoHealDecision (JS), re-evaluado además bajo lock en retryItem.
    const jitter = Math.max(0, Math.min(0.5, Number(policy.jitterRatio ?? 0)));
    const allWaits = [...policy.backoffSeconds, ...(policy.regenBackoffSeconds ?? [])].map((x) => Math.max(0, Number(x) || 0));
    const minWait = allWaits.length ? Math.floor(Math.min(...allWaits) * (1 - jitter)) : 0;
    const backoffs = policy.classAware
      ? [minWait]
      : (policy.backoffSeconds.length ? policy.backoffSeconds : [0]).map((x) => Math.max(0, Math.floor(x)));
    const allowRegex = policy.classAware ? '.' : AUTO_HEAL_SQL_ALLOW_REGEX;
    let cursor: { finishedUs: string; id: string } | null = null;
    while (result.candidates! < maxCandidates) {
      const rows: Array<{
        id: string; job_id: string; item_key: string; type: string; status: string; error: string | null; output_summary: Record<string, any> | null;
        finished_at: Date; finished_us: string; updated_at: Date | null; course_id: number; owner_id: string; blueprint_number: number;
        failure_class: string | null;
      }> = await this.dataSource.query(
        `select g.id, g.job_id, g.item_key, g.type, g.status, g.error, g.output_summary, g.finished_at, g.updated_at,
                ${finishedUsSql}::text as finished_us, pj.course_id, pj.owner_id, b.blueprint_number,
                to_jsonb(g)->>'failure_class' as failure_class
           from public.generation_item_runs g
           join public.production_jobs pj on pj.id = g.job_id
           join public.course_generation_manifests m on m.id = g.manifest_id
           join public.course_blueprints b on b.id = m.blueprint_id
          where pj.execution_mode = 'dynamic_generation'
            and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
            and coalesce(pj.worker_status, '') not in ('cancelled', 'cancelling', 'completed', 'preview')
            and g.status = 'failed'
            and ${latestGenerationPredicate('g')}
            -- I1: solo fallos recientes
            and g.finished_at > $1::timestamptz - make_interval(secs => $2::int)
            -- I1: solo la ejecución vigente del curso (ningún run más nuevo, ni un Manifest más nuevo)
            and not exists (
              select 1 from public.production_jobs pj2
               where pj2.execution_mode = 'dynamic_generation' and pj2.course_id = pj.course_id and pj2.id <> pj.id
                 and (pj2.created_at > pj.created_at or (pj2.created_at = pj.created_at and pj2.id > pj.id)))
            and not exists (select 1 from public.course_generation_manifests m2 where m2.course_id = m.course_id and m2.id > m.id)
            -- I2: allow/deny-list gruesa + precondición del id del proveedor
            and g.error ~* $3 and g.error !~* $4
            and not (g.error ~ '^(gamma_timeout|gamma_poll_failed|gamma_export_missing)'
                     and coalesce(g.output_summary->'external'->>'gammaGenerationId', '') = '')
            and not (g.error ~ '^(video_timeout|video_duration_unmeasured|youtube_upload_failed)'
                     and coalesce(g.output_summary->'external'->>'videogenJobId', '') = '')
            -- M6 + tope: rondas por tipo; espera creciente desde el fallo
            and ${roundsSql} < case when g.type = any($5::text[]) then $6::int else $7::int end
            and g.finished_at <= $1::timestamptz - make_interval(secs => ($8::int[])[least(${roundsSql}, cardinality($8::int[]) - 1) + 1])
            -- m2: enfriamiento tras un rechazo de retryItem (presupuesto, run reemplazado, otro run activo…)
            and not (case when jsonb_typeof(g.output_summary->'autoHeal'->'skipUntilMs') = 'number'
                          then (g.output_summary->'autoHeal'->>'skipUntilMs')::numeric > $12::numeric else false end)
            -- REL MVP: un error ya evaluado como no elegible (C/D, tope, precondición) no se re-evalúa hasta que cambie
            and ($13::boolean is not true or coalesce(g.output_summary->'autoHeal'->>'ineligibleMd5', '') <> md5(g.error))
            and ($9::bigint is null or (${finishedUsSql}, g.id) < ($9::bigint, $10::uuid))
          order by ${finishedUsSql} desc, g.id desc
          limit $11`,
        [
          now.toISOString(), Math.round(Math.min(Math.max(policy.maxAgeHours, 0), AUTO_HEAL_MAX_AGE_HOURS_RANGE.max) * 3600), allowRegex, AUTO_HEAL_SQL_DENY_REGEX,
          [...AUTO_HEAL_WORKER_ITEM_TYPES], policy.maxRounds, policy.browserMaxRounds, backoffs,
          cursor ? cursor.finishedUs : null, cursor ? cursor.id : null, pageSize, now.getTime(), !!policy.classAware,
        ],
      );
      if (rows.length === 0) break;
      result.candidates! += rows.length;
      cursor = { finishedUs: rows[rows.length - 1].finished_us, id: rows[rows.length - 1].id };
      for (const r of rows) await this.autoHealOne(r, now, policy, result);
      if (rows.length < pageSize) break;
    }
    if (this.autoHealLastSkip.size > 5000) this.autoHealLastSkip.clear();
    const byReason: Record<string, number> = {};
    for (const s of result.skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    this.logger.log(
      `auto-heal: barrido — candidatos ${result.candidates}, reabiertos ${result.reopened.length}, ` +
        `omitidos ${result.skipped.length}${result.skipped.length ? ` ${JSON.stringify(byReason)}` : ''}`,
    );
    return result;
  }

  private async autoHealOne(
    r: { id: string; job_id: string; item_key: string; type: string; status: string; error: string | null; output_summary: Record<string, any> | null;
      finished_at: Date; updated_at: Date | null; course_id: number; owner_id: string; blueprint_number: number; failure_class?: string | null },
    now: Date,
    policy: AutoHealPolicy,
    result: AutoHealSweepResult,
  ): Promise<void> {
    const d = autoHealDecision(r, now, policy);
    if (d.heal === false) {
      result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: d.reason });
      // REL MVP: motivo permanente para ESTE error → marca (md5 del error) y el SQL deja de seleccionarlo
      // hasta que el item vuelva a fallar con otro error. Solo si sigue igual (nunca pisa un item que cambió).
      if (policy.classAware && AUTO_HEAL_PERMANENT_SKIPS.includes(d.reason)) {
        await this.dataSource.query(
          `update public.generation_item_runs
              set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('autoHeal',
                    coalesce(output_summary->'autoHeal', '{}'::jsonb) || jsonb_build_object('ineligibleMd5', md5(error), 'ineligibleReason', $2::text))
            where id = $1 and status = 'failed' and error = $3`,
          [r.id, d.reason, r.error],
        ).catch((e) => this.logger.warn(`auto-heal: no se pudo marcar ${r.item_key} como no elegible: ${e instanceof Error ? e.message : String(e)}`));
      }
      return;
    }
    try {
      await this.retryItem(r.course_id, r.owner_id, Number(r.blueprint_number), r.job_id, r.item_key, false, false, { policy, now });
      this.autoHealLastSkip.delete(r.id);
      result.reopened.push({ runId: r.job_id, itemKey: r.item_key, code: d.rule.code, round: d.round, kind: d.kind, strategy: d.strategy });
      this.logger.warn(
        `auto-heal: reabierto ${r.item_key} (run ${r.job_id}) — ${policy.classAware ? `clase ${d.kind} (${d.strategy}), ` : ''}` +
          `ronda ${d.round}/${d.kind === 'B' ? policy.regenMaxRounds ?? 0 : autoHealMaxRoundsFor(r.type, policy)}, ` +
          `código ${d.rule.code}; error previo: ${String(r.error ?? '').slice(0, 200)}`,
      );
    } catch (err) {
      const resp = (err as { getResponse?: () => unknown })?.getResponse?.();
      const code = (resp && typeof resp === 'object' && (resp as any).code) || (err instanceof Error ? err.name : 'error');
      const msg = err instanceof Error ? err.message : String(err);
      result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: String(code) });
      // Fix m2: enfriamiento durable en el item (el SQL lo filtra): un rechazo no vuelve a tomar locks en cada barrido
      // ni a ocupar lugar frente a los elegibles. Solo si sigue failed (nunca pisa un item que cambió).
      try {
        await this.dataSource.query(
          `update public.generation_item_runs
              set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('autoHeal',
                    coalesce(output_summary->'autoHeal', '{}'::jsonb) || jsonb_build_object('skipUntilMs', $2::bigint, 'lastSkipReason', $3::text))
            where id = $1 and status = 'failed'`,
          [r.id, now.getTime() + AUTO_HEAL_SKIP_COOLDOWN_SECONDS * 1000, String(code).slice(0, 100)],
        );
      } catch (e) {
        this.logger.warn(`auto-heal: no se pudo registrar el enfriamiento de ${r.item_key}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const key = `${code}:${msg.slice(0, 120)}`;
      if (this.autoHealLastSkip.get(r.id) !== key) {
        this.autoHealLastSkip.set(r.id, key);
        this.logger.warn(`auto-heal: ${r.item_key} (run ${r.job_id}) no se reabre automáticamente (${code}): ${msg.slice(0, 300)}`);
      }
    }
  }

  /**
   * REL CREDIT — sonda del proveedor tras crédito/cuota agotados (mismo tick que el auto-healer; ver
   * reliability/provider-probe.ts). Por cada run vigente con items `failed` por crédito/cuota de Anthropic u
   * OpenAI: a su hora reabre UN canario por (run, proveedor) con retryItem(auto.providerProbe canary) — un
   * intento, sin consumir las rondas del auto-healer —; si el canario (o una reapertura humana) termina bien,
   * reabre el resto con retryItem(auto.providerProbe resume) (que desbloquea sus dependientes). Mientras
   * espera, deja la próxima sonda en output_summary.providerProbe (vista de recuperación). Todo pasa por los
   * locks y el gate de FinOps (simulación) de retryItem, y en el claim por el runtime guard y el ledger del
   * worker. Apagado con DYNAMIC_AUTO_HEAL_POLICY=legacy.
   */
  async autoProbeProviderCredit(
    opts: { policy?: AutoHealPolicy; now?: Date; limit?: number } = {},
  ): Promise<{
    enabled: boolean;
    runs: number;
    probed: Array<{ runId: string; itemKey: string; provider: string; round: number }>;
    resumed: Array<{ runId: string; itemKey: string; provider: string }>;
    waiting: Array<{ runId: string; provider: string; action: string; nextProbeAt: string | null }>;
    skipped: Array<{ runId: string; itemKey: string; reason: string }>;
  }> {
    const policy = opts.policy ?? autoHealPolicyFromEnv();
    const now = opts.now ?? new Date();
    const limit = Math.max(1, Math.floor(opts.limit ?? 2000));
    const result = {
      enabled: providerProbeEnabled(policy), runs: 0,
      probed: [] as Array<{ runId: string; itemKey: string; provider: string; round: number }>,
      resumed: [] as Array<{ runId: string; itemKey: string; provider: string }>,
      waiting: [] as Array<{ runId: string; provider: string; action: string; nextProbeAt: string | null }>,
      skipped: [] as Array<{ runId: string; itemKey: string; reason: string }>,
    };
    if (!result.enabled) return result;
    type Row = ProviderProbeRow & { job_id: string; item_key: string; type: string; course_id: number; owner_id: string; blueprint_number: number };
    const rows: Row[] = await this.dataSource.query(
      `select g.id, g.job_id, g.item_key, g.type, g.status, g.error, g.output_summary, g.finished_at, g.updated_at, g.claimed_at,
              pj.course_id, pj.owner_id, b.blueprint_number, to_jsonb(g)->>'failure_class' as failure_class
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
         join public.course_generation_manifests m on m.id = g.manifest_id
         join public.course_blueprints b on b.id = m.blueprint_id
        where pj.execution_mode = 'dynamic_generation'
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
          and coalesce(pj.worker_status, '') not in ('cancelled', 'cancelling', 'completed', 'preview')
          and ${latestGenerationPredicate('g')}
          and not exists (
            select 1 from public.production_jobs pj2
             where pj2.execution_mode = 'dynamic_generation' and pj2.course_id = pj.course_id and pj2.id <> pj.id
               and (pj2.created_at > pj.created_at or (pj2.created_at = pj.created_at and pj2.id > pj.id)))
          and not exists (select 1 from public.course_generation_manifests m2 where m2.course_id = m.course_id and m2.id > m.id)
          and (
            -- crédito/cuota (filtro grueso; la decisión fina es providerCreditWaitOf), dentro de la ventana de ~24 h
            (g.status = 'failed' and g.error ~* $2 and g.finished_at > $1::timestamptz - make_interval(hours => $3::int))
            -- estado de una sonda (canario en vuelo / terminado, esperas persistidas)
            or (g.output_summary ? '${PROVIDER_PROBE_KEY}' and g.updated_at > $1::timestamptz - make_interval(hours => $3::int * 2))
            -- detenido por el usuario: el run está pausado a mano (nunca se sondea)
            or (g.status = 'failed' and g.error ~* $4)
          )
        order by g.job_id, g.id
        limit $5`,
      [now.toISOString(), PROVIDER_PROBE_SQL_REGEX, PROVIDER_PROBE_MAX_HOURS, USER_STOPPED_SQL_REGEX, limit],
    );
    const byRun = new Map<string, Row[]>();
    for (const r of rows) {
      if (!byRun.has(r.job_id)) byRun.set(r.job_id, []);
      byRun.get(r.job_id)!.push(r);
    }
    const reopen = async (r: Row, mode: 'canary' | 'resume', provider: FailureProvider): Promise<boolean> => {
      try {
        await this.retryItem(r.course_id, r.owner_id, Number(r.blueprint_number), r.job_id, r.item_key, false, false,
          { policy, now, providerProbe: { mode, provider } });
        return true;
      } catch (err) {
        const resp = (err as { getResponse?: () => unknown })?.getResponse?.();
        const code = String((resp && typeof resp === 'object' && (resp as any).code) || (err instanceof Error ? err.name : 'error')).slice(0, 100);
        const msg = err instanceof Error ? err.message : String(err);
        result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: code });
        // Enfriamiento durable en el item (no vuelve a tomar locks en cada tick); solo si sigue failed.
        await this.dataSource.query(
          `update public.generation_item_runs
              set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('${PROVIDER_PROBE_KEY}',
                    coalesce(output_summary->'${PROVIDER_PROBE_KEY}', '{}'::jsonb) || $2::jsonb)
            where id = $1 and status = 'failed'`,
          [r.id, JSON.stringify({ provider, skipUntilMs: now.getTime() + PROVIDER_PROBE_SKIP_SECONDS * 1000, lastSkipReason: code })],
        ).catch((e) => this.logger.warn(`sonda del proveedor: no se pudo registrar el enfriamiento de ${r.item_key}: ${e instanceof Error ? e.message : String(e)}`));
        this.logger.warn(`sonda del proveedor: ${r.item_key} (run ${r.job_id}) no se reabre (${mode}, ${code}): ${msg.slice(0, 300)}`);
        return false;
      }
    };
    for (const [runId, runRows] of byRun) {
      const plans = planProviderProbes(runRows, now, runId);
      if (plans.some((p) => p.action !== 'none')) result.runs++;
      const byId = new Map(runRows.map((r) => [String(r.id), r]));
      for (const plan of plans) {
        if (plan.action === 'resume') {
          let pending = 0;
          for (const id of plan.waitingIds) {
            const r = byId.get(id)!;
            const skip = Number(providerProbeStateOf(r.output_summary)?.skipUntilMs ?? 0);
            if (Number.isFinite(skip) && skip > now.getTime()) { pending++; continue; }
            if (await reopen(r, 'resume', plan.provider)) {
              result.resumed.push({ runId, itemKey: r.item_key, provider: plan.provider });
              this.logger.warn(`sonda del proveedor: ${plan.provider} volvió — reabierto ${r.item_key} (run ${runId})`);
            } else pending++;
          }
          // Todo el resto reabierto → la prueba de éxito (canario completado) se consume; si quedó alguno
          // (rechazado), se conserva y el próximo barrido lo reintenta (idempotente).
          if (pending === 0 && plan.successIds.length) {
            await this.dataSource.query(
              `update public.generation_item_runs set output_summary = output_summary - '${PROVIDER_PROBE_KEY}'
                where id = any($1::uuid[]) and status = 'completed'`,
              [plan.successIds],
            );
          }
          continue;
        }
        if (plan.action === 'probe' && plan.canaryId) {
          const r = byId.get(plan.canaryId)!;
          if (await reopen(r, 'canary', plan.provider)) {
            result.probed.push({ runId, itemKey: r.item_key, provider: plan.provider, round: plan.round + 1 });
            this.logger.warn(`sonda del proveedor: canario ${r.item_key} (run ${runId}) reabierto — ${plan.provider}, sonda ${plan.round + 1}`);
          }
          continue;
        }
        if (plan.action === 'none') continue;
        result.waiting.push({ runId, provider: plan.provider, action: plan.action, nextProbeAt: plan.nextProbeAt ? plan.nextProbeAt.toISOString() : null });
        if (plan.action !== 'wait' || !plan.nextProbeAt) continue;
        // Vista de recuperación: la próxima sonda (y el inicio de la racha) en cada item que espera.
        const nextIso = plan.nextProbeAt.toISOString();
        for (const id of plan.waitingIds) {
          const r = byId.get(id)!;
          // M1: el estado de una racha vencida se REEMPLAZA (no se mezcla) por el de la racha nueva.
          const same = effectiveProbeStateOf(r, plan.provider, now);
          const firstFailedAt = same?.firstFailedAt
            ?? (r.finished_at ? new Date(r.finished_at as any).toISOString() : plan.streakStartAt?.toISOString() ?? now.toISOString());
          if (same && same.nextProbeAt === nextIso && same.firstFailedAt === firstFailedAt && Number(same.runRound ?? 0) === plan.round) continue;
          await this.dataSource.query(
            `update public.generation_item_runs
                set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('${PROVIDER_PROBE_KEY}',
                      (case when $5::boolean and output_summary->'${PROVIDER_PROBE_KEY}'->>'provider' = $3 then output_summary->'${PROVIDER_PROBE_KEY}' else '{}'::jsonb end) || $2::jsonb)
              where id = $1 and status = 'failed' and error is not distinct from $4`,
            [r.id, JSON.stringify({ provider: plan.provider, firstFailedAt, nextProbeAt: nextIso, runRound: plan.round }), plan.provider, r.error, !!same],
          ).catch((e) => this.logger.warn(`sonda del proveedor: no se pudo registrar la espera de ${r.item_key}: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    }
    if (result.probed.length || result.resumed.length || result.skipped.length) {
      this.logger.log(`sonda del proveedor: runs ${result.runs}, canarios ${result.probed.length}, reabiertos ${result.resumed.length}, omitidos ${result.skipped.length}`);
    }
    return result;
  }

  /**
   * EV6 DoD BE-B (reglas 3–4 del usuario) — barrido del reintento automático SEGURO (mismo tick que el
   * auto-healer). Solo items `failed` de la ejecución vigente del curso cuyo último error es un rechazo
   * DEFINITIVO sin gasto (auto-heal.ts SAFE_AUTO_RETRY_RULES: videogen_submit_rejected,
   * gamma_submit_failed), recientes, sin su único reintento usado. Cada uno pasa por retryItem(auto.safe):
   * misma transacción y locks, política re-evaluada bajo lock, gate de FinOps en modo simulación (dentro
   * del presupuesto YA aprobado; nunca crea un estimado ni una aprobación) y, en el worker, el runtime
   * guard antes del envío. Un rechazo de retryItem (presupuesto, run reemplazado…) marca el item
   * `safeAutoRetry.declined` → queda para un admin (sin reintentos en cada tick).
   */
  async autoRetrySafeRejections(
    opts: { policy?: AutoHealPolicy; now?: Date; limit?: number } = {},
  ): Promise<{ candidates: number; retried: Array<{ runId: string; itemKey: string; code: string }>; skipped: Array<{ runId: string; itemKey: string; reason: string }> }> {
    const policy = opts.policy ?? autoHealPolicyFromEnv();
    const now = opts.now ?? new Date();
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const result = { candidates: 0, retried: [] as Array<{ runId: string; itemKey: string; code: string }>, skipped: [] as Array<{ runId: string; itemKey: string; reason: string }> };
    const rows: Array<{
      id: string; job_id: string; item_key: string; type: string; status: string; error: string | null; output_summary: Record<string, any> | null;
      finished_at: Date; updated_at: Date | null; course_id: number; owner_id: string; blueprint_number: number;
    }> = await this.dataSource.query(
      `select g.id, g.job_id, g.item_key, g.type, g.status, g.error, g.output_summary, g.finished_at, g.updated_at,
              pj.course_id, pj.owner_id, b.blueprint_number
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
         join public.course_generation_manifests m on m.id = g.manifest_id
         join public.course_blueprints b on b.id = m.blueprint_id
        where pj.execution_mode = 'dynamic_generation'
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
          and coalesce(pj.worker_status, '') not in ('cancelled', 'cancelling', 'completed', 'preview')
          and g.status = 'failed'
          and ${latestGenerationPredicate('g')}
          and g.finished_at > $1::timestamptz - make_interval(secs => $2::int)
          and not exists (
            select 1 from public.production_jobs pj2
             where pj2.execution_mode = 'dynamic_generation' and pj2.course_id = pj.course_id and pj2.id <> pj.id
               and (pj2.created_at > pj.created_at or (pj2.created_at = pj.created_at and pj2.id > pj.id)))
          and not exists (select 1 from public.course_generation_manifests m2 where m2.course_id = m.course_id and m2.id > m.id)
          and g.error ~ $3
          and not (g.output_summary ? 'safeAutoRetry' and (g.output_summary->'safeAutoRetry' ? 'declined'
                   or coalesce((g.output_summary->'safeAutoRetry'->>'rounds')::numeric, 0) >= $4::int))
        order by g.finished_at desc, g.id desc
        limit $5`,
      [now.toISOString(), Math.round(Math.min(Math.max(policy.maxAgeHours, 0), AUTO_HEAL_MAX_AGE_HOURS_RANGE.max) * 3600), SAFE_AUTO_RETRY_SQL_REGEX,
        SAFE_AUTO_RETRY_MAX_ROUNDS, limit],
    );
    result.candidates = rows.length;
    for (const r of rows) {
      const d = safeAutoRetryDecision(r, now, policy);
      if (d.heal === false) {
        result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: d.reason });
        continue;
      }
      try {
        await this.retryItem(r.course_id, r.owner_id, Number(r.blueprint_number), r.job_id, r.item_key, d.rule.resubmitVideo, false, { policy, now, safe: true });
        result.retried.push({ runId: r.job_id, itemKey: r.item_key, code: d.rule.code });
        this.logger.warn(`reintento automático seguro: ${r.item_key} (run ${r.job_id}) — ${d.rule.code} (rechazo definitivo sin gasto), única vez`);
      } catch (err) {
        const resp = (err as { getResponse?: () => unknown })?.getResponse?.();
        const code = String((resp && typeof resp === 'object' && (resp as any).code) || (err instanceof Error ? err.name : 'error')).slice(0, 100);
        result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: code });
        try {
          await this.dataSource.query(
            `update public.generation_item_runs
                set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('safeAutoRetry',
                      coalesce(output_summary->'safeAutoRetry', '{}'::jsonb) || jsonb_build_object('declined', $2::text, 'declinedAt', $3::text))
              where id = $1 and status = 'failed'`,
            [r.id, code, now.toISOString()],
          );
        } catch (e) {
          this.logger.warn(`reintento automático seguro: no se pudo registrar el rechazo de ${r.item_key}: ${e instanceof Error ? e.message : String(e)}`);
        }
        this.logger.warn(`reintento automático seguro: ${r.item_key} (run ${r.job_id}) no se reintenta (${code}); queda para un admin`);
      }
    }
    if (rows.length) {
      this.logger.log(`reintento automático seguro: candidatos ${result.candidates}, reintentados ${result.retried.length}, omitidos ${result.skipped.length}`);
    }
    return result;
  }

  /**
   * #583 — lo pendiente (reservas reales sin liquidar) de un item en el ledger, de los intentos que todavía
   * no se reconocieron, por proveedor. Es lo que costaría repetir la operación incierta.
   */
  private async ambiguousAudioPending(
    q: { query: (sql: string, params?: any[]) => Promise<any> },
    itemRunId: string,
    outputSummary: Record<string, any> | null,
  ): Promise<AmbiguousAudioPending> {
    const ack = Number(outputSummary?.reconciliationAcknowledgedThroughAttempt ?? 0);
    const rows: Array<{ provider: string; amount: string }> = await q.query(
      `select e.provider, coalesce(sum(e.amount), 0)::text as amount
         from public.generation_cost_events e
        where e.item_run_id = $1 and e.event_kind = 'CHARGE' and e.billing_account <> 'mock'
          and coalesce((e.metadata->>'reservation') = 'true', false)
          and coalesce(e.attempt, 0) > $2::int
          and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)
        group by e.provider`,
      [itemRunId, Number.isFinite(ack) ? Math.floor(ack) : 0],
    );
    return {
      pendingUsd: rows.reduce((t, r) => t + Number(r.amount || 0), 0),
      providers: rows.map((r) => String(r.provider)).sort(),
    };
  }

  /**
   * #583 (decisión del usuario 2026-10-02) — barrido del reenvío automático ÚNICO de un audio con
   * resultado incierto (mismo tick que el auto-healer). Solo audio_welcome / audiobook_chapter con
   * `provider_reconciliation_required: openai …`, recientes, de la ejecución vigente, sin su reenvío
   * usado ni rechazado, y con lo pendiente del item ≤ AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD. Pasa por
   * retryItem(auto.ambiguousAudio, resubmitProvider): locks, decisión re-evaluada con el ledger bajo lock,
   * gate de FinOps en simulación (presupuesto YA autorizado) y, en el worker, el runtime guard. Lo que no
   * califica (sobre el tope, otro proveedor pendiente, FinOps lo rechaza…) queda `declined` → admin.
   */
  async autoResubmitAmbiguousAudio(
    opts: { policy?: AutoHealPolicy; now?: Date; limit?: number; maxUsd?: number } = {},
  ): Promise<{ candidates: number; resubmitted: Array<{ runId: string; itemKey: string; pendingUsd: number | null }>; skipped: Array<{ runId: string; itemKey: string; reason: string }> }> {
    const policy = opts.policy ?? autoHealPolicyFromEnv();
    const now = opts.now ?? new Date();
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const maxUsd = typeof opts.maxUsd === 'number' && opts.maxUsd >= 0 ? opts.maxUsd : AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD;
    const result = { candidates: 0, resubmitted: [] as Array<{ runId: string; itemKey: string; pendingUsd: number | null }>, skipped: [] as Array<{ runId: string; itemKey: string; reason: string }> };
    const rows: Array<{
      id: string; job_id: string; item_key: string; type: string; status: string; error: string | null; output_summary: Record<string, any> | null;
      finished_at: Date; updated_at: Date | null; course_id: number; owner_id: string; blueprint_number: number;
    }> = await this.dataSource.query(
      `select g.id, g.job_id, g.item_key, g.type, g.status, g.error, g.output_summary, g.finished_at, g.updated_at,
              pj.course_id, pj.owner_id, b.blueprint_number
         from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
         join public.course_generation_manifests m on m.id = g.manifest_id
         join public.course_blueprints b on b.id = m.blueprint_id
        where pj.execution_mode = 'dynamic_generation'
          and coalesce(pj.status, '') not in ('cancelled', 'cancelling')
          and coalesce(pj.worker_status, '') not in ('cancelled', 'cancelling', 'completed', 'preview')
          and g.status = 'failed'
          and g.type = any($6::text[])
          and ${latestGenerationPredicate('g')}
          and g.finished_at > $1::timestamptz - make_interval(secs => $2::int)
          and not exists (
            select 1 from public.production_jobs pj2
             where pj2.execution_mode = 'dynamic_generation' and pj2.course_id = pj.course_id and pj2.id <> pj.id
               and (pj2.created_at > pj.created_at or (pj2.created_at = pj.created_at and pj2.id > pj.id)))
          and not exists (select 1 from public.course_generation_manifests m2 where m2.course_id = m.course_id and m2.id > m.id)
          and g.error ~ $3
          and not (g.output_summary ? 'ambiguousAudioResubmit' and (g.output_summary->'ambiguousAudioResubmit' ? 'declined'
                   or coalesce((g.output_summary->'ambiguousAudioResubmit'->>'rounds')::numeric, 0) >= $4::int))
        order by g.finished_at desc, g.id desc
        limit $5`,
      [now.toISOString(), Math.round(Math.min(Math.max(policy.maxAgeHours, 0), AUTO_HEAL_MAX_AGE_HOURS_RANGE.max) * 3600), AMBIGUOUS_AUDIO_RESUBMIT_SQL_REGEX,
        AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS, limit, [...AMBIGUOUS_AUDIO_RESUBMIT_TYPES]],
    );
    result.candidates = rows.length;
    const decline = async (r: { id: string; item_key: string }, reason: string, pendingUsd: number | null) => {
      try {
        await this.dataSource.query(
          `update public.generation_item_runs
              set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('ambiguousAudioResubmit',
                    coalesce(output_summary->'ambiguousAudioResubmit', '{}'::jsonb) || jsonb_build_object('declined', $2::text, 'declinedAt', $3::text, 'pendingUsd', $4::numeric, 'maxUsd', $5::numeric))
            where id = $1 and status = 'failed'`,
          [r.id, reason.slice(0, 100), now.toISOString(), pendingUsd, maxUsd],
        );
      } catch (e) {
        this.logger.warn(`reenvío de audio incierto: no se pudo registrar el rechazo de ${r.item_key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    for (const r of rows) {
      const pending = await this.ambiguousAudioPending(this.dataSource, r.id, r.output_summary);
      const d = ambiguousAudioResubmitDecision(r, now, pending, policy, maxUsd);
      if (d.heal === false) {
        result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: d.reason });
        // Lo que nunca va a calificar queda para un admin YA (sin re-evaluarlo en cada tick).
        if (d.reason === 'over_threshold' || d.reason === 'missing_precondition' || d.reason === 'denied') {
          await decline(r, d.reason, d.pendingUsd ?? null);
          this.logger.warn(`reenvío de audio incierto: ${r.item_key} (run ${r.job_id}) no se reenvía solo (${d.reason}, pendiente USD ${d.pendingUsd ?? '?'}); queda para un admin`);
        }
        continue;
      }
      try {
        await this.retryItem(r.course_id, r.owner_id, Number(r.blueprint_number), r.job_id, r.item_key, false, true, { policy, now, ambiguousAudio: true, maxUsd });
        result.resubmitted.push({ runId: r.job_id, itemKey: r.item_key, pendingUsd: d.pendingUsd });
        this.logger.warn(`reenvío de audio incierto: ${r.item_key} (run ${r.job_id}) — UN reenvío automático (pendiente USD ${d.pendingUsd} ≤ ${maxUsd}); la reserva incierta queda contada`);
      } catch (err) {
        const resp = (err as { getResponse?: () => unknown })?.getResponse?.();
        const code = String((resp && typeof resp === 'object' && ((resp as any).reason || (resp as any).code)) || (err instanceof Error ? err.name : 'error')).slice(0, 100);
        result.skipped.push({ runId: r.job_id, itemKey: r.item_key, reason: code });
        // Una carrera (otro tick/retry lo cambió: espera, ya no failed) o una falla de infraestructura
        // (DB/lock/timeout, FinOps no disponible, 5xx) se re-evalúa en el próximo tick (fix round 1, M5): solo
        // un rechazo DEFINITIVO (presupuesto, tope, precondición, run reemplazado…) lo deja para un admin.
        // La ventana de edad (maxAgeHours) sigue acotando los reintentos.
        const status = (err as { getStatus?: () => number })?.getStatus?.();
        const transient = code === 'backoff' || code === 'not_failed' || code === 'auto_heal_not_eligible' ||
          /unavailable|timeout|ECONN|EMAXCONN|deadlock|lock|QueryFailed|Connection|InternalServerError|Error$/i.test(code) ||
          (typeof status === 'number' && status >= 500) || typeof status !== 'number';
        if (transient) continue;
        await decline(r, code, d.pendingUsd);
        this.logger.warn(`reenvío de audio incierto: ${r.item_key} (run ${r.job_id}) no se reenvía (${code}); queda para un admin`);
      }
    }
    if (rows.length) {
      this.logger.log(`reenvío de audio incierto: candidatos ${result.candidates}, reenviados ${result.resubmitted.length}, omitidos ${result.skipped.length}`);
    }
    return result;
  }

  /**
   * DN-1 (follow-up 5B.2.A): resolución EXPLÍCITA de una subida a YouTube
   * ambigua (`youtubeUploadStartedAt` sin `youtubeVideoId`: crash, lease
   * perdida, red/timeout a mitad del PUT). Nunca es automática:
   * - `confirm_existing` + `youtubeVideoId` (11 chars): el usuario encontró el
   *   video en su canal → se registra ese id (URL canónica) y el item vuelve a
   *   pending; el worker SOLO finaliza (artifact + complete), sin subir nada.
   * - `authorize_reupload`: el usuario verificó que NO hay video (o acepta un
   *   duplicado) → se archiva el marcador y el item vuelve a pending; el worker
   *   sube UNA vez más (si vuelve a quedar ambigua, se pide de nuevo).
   * Ninguna de las dos vuelve a enviar nada a Videogen (el MP4 ya existe).
   * Solo items `video` `failed` de un run `youtube` en estado ambiguo; si no → 409.
   */
  async resolveYoutubeUpload(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    runId: string,
    itemKey: string,
    action: YoutubeResolutionAction,
    youtubeVideoId?: string,
    /** EV6 DoD BE-B: un SUPER_ADMIN resuelve sobre el curso de cualquier dueño (cola de recuperación). */
    actor?: { id?: string | null; email?: string | null },
  ): Promise<ItemRunDto> {
    if (actor) ownerId = await this.ownerForActor(courseId, ownerId, actor);
    assertDynamicOwnerAllowed(ownerId);
    if (action !== 'confirm_existing' && action !== 'authorize_reupload') {
      throw new BadRequestException('action debe ser "confirm_existing" o "authorize_reupload"');
    }
    if (action === 'confirm_existing' && !(typeof youtubeVideoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId))) {
      throw new BadRequestException('confirm_existing requiere youtubeVideoId (id de YouTube de 11 caracteres)');
    }
    if (action === 'authorize_reupload' && youtubeVideoId !== undefined) {
      throw new BadRequestException('authorize_reupload no admite youtubeVideoId');
    }
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    let job = await this.loadRunRow(courseId, manifest, runId);
    job = await this.reconcileCancellation(job);
    if (isCancelledLike(job)) {
      throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden resolver subidas`);
    }
    const strategy = frozenVideoDeliveryOf(job.input_payload);
    if (strategy !== 'youtube') {
      throw new ConflictException({ message: `not_youtube_run: la ejecución ${job.id} no entrega sus videos por YouTube (videoDelivery=${strategy})`, code: 'not_youtube_run' });
    }

    // Estado del item ANTES de consultar a Google (sin red si no hay nada que resolver).
    const [pre] = await this.dataSource.query(
      `select type, status, error, output_summary from public.generation_item_runs g
        where g.job_id = $1 and g.item_key = $2 and ${latestGenerationPredicate('g')}`,
      [job.id, itemKey],
    );
    if (!pre) throw new NotFoundException(`El item "${itemKey}" no existe en la ejecución ${job.id}`);
    if (pre.type !== 'video') throw new BadRequestException(`"${itemKey}" no es un item de video`);
    if (pre.status !== 'failed' || !isAmbiguousYoutubeUpload(pre)) {
      throw new ConflictException({
        message: `not_ambiguous: "${itemKey}" no tiene una subida a YouTube ambigua pendiente de resolución (estado ${pre.status})`,
        code: 'not_ambiguous',
      });
    }

    // Review DN-1 M6: un id ya asignado a OTRO item del run no se puede reutilizar (sin red).
    if (action === 'confirm_existing') await this.assertYoutubeIdUnused(this.dataSource, job.id, itemKey, youtubeVideoId as string);

    // DN-1 ruling A: confirm_existing solo con un video VERIFICADO en YouTube con las
    // credenciales refrescadas del owner (existe, es de SU canal conectado, es Unlisted).
    // Fuera de la tx (red); si no pasa → 409 legible y nada escrito.
    let verified: Record<string, any> | null = null;
    if (action === 'confirm_existing') {
      if (!this.youtubePreflight) {
        throw new ConflictException({
          message: `${YOUTUBE_VIDEO_NOT_VERIFIED}:preflight_unavailable: No se pudo verificar el video en YouTube. No se registró nada.`,
          code: YOUTUBE_VIDEO_NOT_VERIFIED, reason: 'preflight_unavailable',
        });
      }
      let v;
      try {
        v = await this.youtubePreflight.verifyExistingVideo(ownerId, youtubeVideoId as string);
      } catch (err) {
        this.logger.warn(`verifyExistingVideo falló con error inesperado: ${err instanceof Error ? err.message : String(err)}`);
        v = { ok: false as const, reason: 'video_lookup_failed' as const };
      }
      if (v.ok === false) {
        const privacy = v.privacyStatus ? { privacyStatus: v.privacyStatus } : {};
        throw new ConflictException({
          message: `${YOUTUBE_VIDEO_NOT_VERIFIED}:${v.reason}: ${youtubeVideoVerifyMessage(v)} No se registró nada.`,
          code: YOUTUBE_VIDEO_NOT_VERIFIED, reason: v.reason, ...privacy,
        });
      }
      verified = { channelId: v.channelId, privacyStatus: v.privacyStatus, uploadStatus: v.uploadStatus, verifiedAt: new Date().toISOString() };
    }

    const targetId = await this.tx(async (qr) => {
      await this.lockCourseRuns(qr, courseId);
      const [locked] = await qr.query(`select id, status, worker_status from public.production_jobs where id = $1 for update`, [job.id]);
      if (isCancelledLike(locked)) {
        throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden resolver subidas`);
      }
      const superseding = await this.findSupersedingRun(qr, job.id);
      if (superseding) throw this.supersededConflict(job.id, superseding);
      if (!ACTIVE_RUN_WORKER_STATUSES.includes(String(locked.worker_status))) {
        const other = await this.findActiveRunOnOtherManifest(qr, courseId, manifest.id);
        if (other) throw this.otherActiveRunConflict(other, manifest);
      }
      const items: Array<{ id: string; item_key: string; status: ItemRunStatus; depends_on: string[]; type: string; error: string | null; output_summary: Record<string, any> | null }> =
        await qr.query(
          `select id, item_key, status, depends_on, type, error, output_summary
              from public.generation_item_runs g
              where g.job_id = $1 and ${latestGenerationPredicate('g')}
              order by id
              for update`,
          [job.id],
        );
      const target = items.find((i) => i.item_key === itemKey);
      if (!target) throw new NotFoundException(`El item "${itemKey}" no existe en la ejecución ${job.id}`);
      if (target.type !== 'video') throw new BadRequestException(`"${itemKey}" no es un item de video`);
      if (target.status !== 'failed' || !isAmbiguousYoutubeUpload(target)) {
        throw new ConflictException({
          message: `not_ambiguous: "${itemKey}" no tiene una subida a YouTube ambigua pendiente de resolución (estado ${target.status})`,
          code: 'not_ambiguous',
        });
      }
      if (action === 'confirm_existing') await this.assertYoutubeIdUnused(qr, job.id, itemKey, youtubeVideoId as string);
      const os = target.output_summary ?? {};
      if (!os.external?.videogenJobId || !os.videogenDownloadUrl) {
        throw new ConflictException({ message: `render_missing: "${itemKey}" no tiene el render de Videogen registrado; no se puede resolver la subida`, code: 'render_missing' });
      }
      const at = new Date().toISOString();
      const resolution: Record<string, any> = { action, at, by: ownerId };
      if (action === 'confirm_existing') {
        resolution.youtubeVideoId = youtubeVideoId;
        resolution.verified = verified;
      }
      const next: Record<string, any> = {
        ...os,
        delivery: 'completed_local',
        youtubeUploadStartedAt: null,
        youtubeResolution: resolution,
        previousYoutubeUploads: [
          ...(Array.isArray(os.previousYoutubeUploads) ? os.previousYoutubeUploads : []),
          { youtubeUploadStartedAt: os.youtubeUploadStartedAt ?? null, error: target.error, resolvedAt: at, action },
        ],
        previousErrors: [
          ...(Array.isArray(os.previousErrors) ? os.previousErrors : []),
          { error: target.error, retriedAt: at, resolution: action },
        ],
      };
      if (action === 'confirm_existing') {
        next.external = { ...(os.external ?? {}), youtubeVideoId, youtubeUrl: canonicalYoutubeWatchUrl(youtubeVideoId as string) };
      }
      const updated = returningRows(
        await qr.query(
          `update public.generation_item_runs
              set status = 'pending', max_attempts = attempt_count + 3, output_summary = $2::jsonb, error = null,
                  next_retry_at = null, worker_id = null, lease_until = null, finished_at = null, updated_at = now()
            where id = $1 and status = 'failed'
            returning id`,
          [target.id, JSON.stringify(next)],
        ),
      );
      if (updated.length !== 1) throw new InternalServerErrorException(`No se pudo reabrir el item "${itemKey}" (fila no actualizada)`);
      await recordItemReopened(qr, target.id, {
        actor: isSuperAdminEmail(actor?.email) ? adminActor(actor?.email) : actor?.id && actor.id !== ownerId ? adminActor(actor.id) : 'owner',
        strategy: `youtube_${action}`,
      });
      const toUnblock = this.dependentsToUnblock(items, itemKey);
      if (toUnblock.length > 0) {
        await qr.query(
          `update public.generation_item_runs set status = 'pending', finished_at = null, updated_at = now()
            where id = any($1::uuid[]) and status = 'blocked'`,
          [toUnblock],
        );
      }
      if (!ACTIVE_RUN_WORKER_STATUSES.includes(String(locked.worker_status))) {
        try {
          await qr.query(
            `update public.production_jobs
                set status = 'queued', worker_status = 'queued', finished_at = null,
                    error_message = null, next_retry_at = null, updated_at = now()
              where id = $1`,
            [job.id],
          );
        } catch (err) {
          if (isActiveRunConflict(err)) {
            throw new ConflictException(`Ya hay otra ejecución activa para el Manifest #${manifest.id}; no se puede reabrir ${job.id}`);
          }
          throw err;
        }
      }
      this.logger.warn(`resolveYoutubeUpload: ${action} en "${itemKey}" (run ${job.id})${youtubeVideoId ? ` id=${youtubeVideoId}` : ''}`);
      return target.id;
    });
    const [row] = await this.dataSource.query(`select * from public.generation_item_runs where id = $1`, [targetId]);
    return this.toItemDto(row, strategy);
  }

  /**
   * F78-BE2: regeneración explícita (y posiblemente paga) de UN item de un
   * run completed o activo — el caso típico es el video STALE_NO_AUTO de un
   * run B (Fase 8), pero sirve para cualquier item que el usuario quiera
   * regenerar. Nunca reescribe historia:
   * - crea una fila NUEVA en generation_item_runs del MISMO run con
   *   generation = max + 1 e idempotency key propia (sha256(manifestId:
   *   itemKey:generation)) → el ejecutor/worker genera salida nueva (un video
   *   nuevo en Videogen, nunca reutiliza el `external` anterior);
   * - la fila anterior queda intacta; sus artifacts pasan a `status='stale'`
   *   con `metadata.staleReason` (tabla de Fase 8, fila REGENERATE: solo
   *   status + metadata, nunca rutas ni filas). Cuando la generación nueva
   *   completa, resolver, precheck del paquete y Coherence usan la completada
   *   más reciente (item-generations.ts);
   * - regenerar un content hace CASCADA: scorm del capítulo + examen del
   *   módulo (generación nueva, o WAITS si todavía no se generaron) y el video
   *   del capítulo queda STALE_NO_AUTO (nunca se regenera solo);
   * - si el run estaba completed se reabre (queued).
   *
   * Costo: `confirmPaid === true` (literal) es obligatorio cuando la
   * regeneración puede costar (video 'real' o items LLM). Solo un video
   * 'mock' no cuesta.
   *
   * Fix wave I1 — `dryRun:true`: MISMO planificador (planRegeneration), sin
   * locks ni escrituras; devuelve `{dryRun, affected, blockers, costKind,
   * currentGeneration}`. Los gates de flag/allow-list/ownership aplican (403
   * /404); el 403 de video real y los 409 se informan como `blockers`.
   * Fix wave I2 — `expectedGeneration`: si viene y la generación vigente del
   * item es otra → 409 `generation_changed` con `currentGeneration` (sin
   * escribir). La idempotencia en vuelo va ANTES (no cambia).
   */
  async regenerateItem(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    runId: string,
    itemKey: string,
    opts: RegenerateItemOptions | boolean | undefined,
    /** EV6 DoD BE-B: un SUPER_ADMIN regenera sobre el curso de cualquier dueño (cola de recuperación). */
    actor?: { id?: string | null; email?: string | null },
  ): Promise<RegenerateItemResult | RegenerateDryRunResult> {
    const o: RegenerateItemOptions = typeof opts === 'object' && opts !== null ? opts : { confirmPaid: opts as boolean | undefined };
    if (actor) ownerId = await this.ownerForActor(courseId, ownerId, actor);
    assertDynamicOwnerAllowed(ownerId);
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    let job = await this.loadRunRow(courseId, manifest, runId);
    const mItem = manifest.manifest.items.find((it) => it.key === itemKey);
    if (!mItem) {
      throw new NotFoundException(`El item "${itemKey}" no existe en el Manifest de la ejecución ${runId}`);
    }
    const videoMode = this.videoModeOf(job);
    const costKind = regenerationCostKind(mItem.type, videoMode);
    job = await this.reconcileCancellation(job);

    if (o.dryRun) {
      // Lectura sin locks y sin escrituras: el mismo planificador que la llamada real.
      const plan = await this.planRegeneration(this.dataSource, false, {
        courseId, ownerId, job, manifest, mItem, itemKey, videoMode, costKind, expectedGeneration: o.expectedGeneration,
      });
      const blockers = plan.blockers.map((b) => ({ code: b.code, message: b.message }));
      // DN-1: el gate de entrega va justo después del 403 de video real (mismo orden que la llamada real).
      if (mItem.type === 'video') {
        const gb = await this.videoGateBlocker(
          ownerId,
          frozenRunVideoGate({ videoWork: 1, videoMode, strategy: frozenVideoDeliveryOf(job.input_payload) }),
        );
        if (gb) {
          const at = blockers.findIndex((b) => b.code !== 'real_video_not_allowed');
          blockers.splice(at === -1 ? blockers.length : at, 0, { code: gb.code, message: gb.message });
        }
      }
      return {
        dryRun: true,
        costKind,
        currentGeneration: plan.currentGeneration,
        affected: plan.affected,
        blockers,
        cost: await this.regenerationCostPreview(manifest, plan.affected, this.spendModesOf(job)).catch((err) => {
          throw this.finopsUnavailable(err);
        }),
      };
    }

    if (o.autoRepair) {
      // REL MVP: solo componentes de la IA, sin cascada y una sola vez por item (nunca un proveedor pagado ni un bucle).
      const notEligible = (reason: string) => new ConflictException({ message: `auto_repair_not_eligible: "${itemKey}" (${reason})`, code: 'auto_repair_not_eligible', reason });
      if (costKind !== 'llm') throw notEligible(`tipo ${mItem.type}`);
      const cascade = regenerationCascade(manifest.rulesVersion, manifest.manifest.items,
        { key: itemKey, type: mItem.type, moduleId: mItem.moduleId ?? null, chapterId: mItem.chapterId ?? null });
      if (cascade.regenerate.length > 0 || cascade.stale.length > 0) throw notEligible('regenerarlo arrastra otros componentes');
      const [latest] = await this.dataSource.query(
        `select output_summary from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [job.id, itemKey]);
      if (latest?.output_summary?.regeneration?.reason === PACKAGE_REPAIR_REASON) throw notEligible('ya se reparó una vez');
    }
    if (costKind !== 'none' && o.confirmPaid !== true && !o.autoRepair) {
      throw new BadRequestException({
        message:
          `confirm_paid_required: regenerar "${itemKey}" tiene costo (${costKind === 'videogen' ? 'video real en Videogen' : costKind === 'gamma' ? 'presentación en Gamma' : costKind === 'tts' ? 'audio TTS' : 'créditos de IA'}); ` +
          'reenviá con {"confirmPaid": true} para confirmarlo explícitamente',
        code: 'confirm_paid_required',
        costKind,
      });
    }
    // Video real = gasto en Videogen → allow-list de video real (fail closed).
    if (mItem.type === 'video' && videoMode === 'real') assertRealVideoAllowed(ownerId);
    // DN-1: regenerar un video real = envío NUEVO a Videogen → entrega YouTube + preflight OK.
    if (mItem.type === 'video') {
      await this.enforceVideoGate(ownerId, frozenRunVideoGate({ videoWork: 1, videoMode, strategy: frozenVideoDeliveryOf(job.input_payload) }));
    }
    if (isCancelledLike(job)) {
      throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden regenerar items`);
    }
    // V2.1 RF-b: estimado de la regeneración + gate de presupuesto (reemplaza el
    // binario confirmPaid por un monto cuando hay un proveedor pagado real).
    await this.finopsRegenerationGate(courseId, ownerId, manifest, job, mItem, itemKey, videoMode);

    const outcome = await this.tx(async (qr) => {
      await this.lockCourseRuns(qr, courseId);
      const [locked] = await qr.query(`select * from public.production_jobs where id = $1 for update`, [job.id]);
      const plan = await this.planRegeneration(qr, true, {
        courseId, ownerId, job: locked, manifest, mItem, itemKey, videoMode, costKind, expectedGeneration: o.expectedGeneration,
      });
      if (plan.inFlight) {
        return {
          kind: 'existing' as const,
          itemRunId: plan.latest.id as string,
          previousItemRunId: plan.latest.output_summary.regeneration.fromItemRunId as string,
          previousGeneration: Number(plan.latest.output_summary.regeneration.fromGeneration),
          affected: undefined as RegenerationAffectedItem[] | undefined,
        };
      }
      // La primera traba es el error de siempre (mismo orden y códigos).
      if (plan.blockers.length > 0) throw plan.blockers[0].error();
      // V2.1 fix round 1 (I2): la cascada también puede costar (p.ej. v3: regenerar un video
      // mock regenera sus interacciones con LLM) → confirmPaid aunque el pedido en sí sea gratis.
      const paidCascade = plan.cascade.find((c) => c.costKind !== 'none');
      if (o.autoRepair && (plan.cascade.length > 0 || plan.staleDeps.length > 0)) {
        throw new ConflictException({ message: `auto_repair_not_eligible: "${itemKey}" (cascada)`, code: 'auto_repair_not_eligible', reason: 'cascade' });
      }
      if (paidCascade && o.confirmPaid !== true) {
        throw new BadRequestException({
          message:
            `confirm_paid_required: regenerar "${itemKey}" regenera también "${paidCascade.key}" (${paidCascade.costKind}); ` +
            'reenviá con {"confirmPaid": true} para confirmarlo explícitamente',
          code: 'confirm_paid_required',
          costKind: paidCascade.costKind,
        });
      }
      return this.applyRegeneration(qr, plan, {
        job: locked, manifest, itemKey, mItem, ownerId, costKind,
        // REL R2 (M4): la generación nueva queda en el log de intentos como reapertura (dueño o admin).
        attemptActor: o.autoRepair ? 'recovery' : isSuperAdminEmail(actor?.email) ? adminActor(actor?.email) : 'owner',
        autoRepair: o.autoRepair,
      });
    });

    const [row] = await this.dataSource.query(`select * from public.generation_item_runs where id = $1`, [outcome.itemRunId]);
    let affected: RegenerationAffectedItem[] = outcome.affected ?? [];
    if (outcome.kind === 'existing') {
      affected = this.storedAffected(row, itemKey, costKind);
    }
    return {
      created: outcome.kind === 'created',
      costKind,
      previousItemRunId: outcome.previousItemRunId,
      previousGeneration: outcome.previousGeneration,
      item: this.toItemDto(row, frozenVideoDeliveryOf(job.input_payload)),
      affected,
      run: await this.buildRunDto(await this.loadJobById(job.id), manifest),
    };
  }

  /**
   * REL MVP — reparación automática del empaque: el validador del paquete final rechazó el contenido de
   * `itemKey` (EXAM_BANK_INVALID, H5P inválido, …). Regenera SOLO ese componente (generación nueva, una
   * vez por item, sin cascada, solo IA) con las mismas reglas, locks y gate de FinOps que regenerateItem;
   * el run se reabre y, al completarse, el empaque automático vuelve a correr. Lanza si no es elegible.
   */
  async autoRepairItemForPackage(runId: string, itemKey: string, code: string): Promise<RegenerateItemResult> {
    const [r] = await this.dataSource.query(
      `select pj.course_id, pj.owner_id, b.blueprint_number
         from public.production_jobs pj
         join public.course_generation_manifests m on m.id = (pj.input_payload->>'manifestId')::bigint
         join public.course_blueprints b on b.id = m.blueprint_id
        where pj.id = $1 and pj.execution_mode = 'dynamic_generation'`,
      [runId],
    );
    if (!r) throw new NotFoundException(`auto_repair: el run ${runId} no existe`);
    const out = await this.regenerateItem(Number(r.course_id), String(r.owner_id), Number(r.blueprint_number), runId, itemKey,
      { confirmPaid: true, autoRepair: { code: String(code).slice(0, 64) } });
    this.logger.warn(`auto-repair (empaque): ${itemKey} (run ${runId}) regenerado por ${code}`);
    return out as RegenerateItemResult;
  }

  /** Filas afectadas guardadas en una regeneración en vuelo (o solo el item si no hubo cascada), con created:false. */
  private storedAffected(row: any, itemKey: string, costKind: RegenerationCostKind): RegenerationAffectedItem[] {
    const stored: RegenerationAffectedItem[] = Array.isArray(row.output_summary?.regeneration?.cascade)
      ? row.output_summary.regeneration.cascade
      : [{ itemKey, type: row.type, itemRunId: row.id, generation: Number(row.generation), action: 'REGENERATE', created: true, costKind }];
    return stored.map((a) => ({ ...a, created: false }));
  }

  /**
   * Planificador ÚNICO de regenerateItem (real y dryRun). Solo lee. Con
   * `forUpdate` (llamada real, dentro de la tx y tras el lock del curso +
   * FOR UPDATE del run) bloquea las filas que va a leer; en dryRun lee sin
   * locks. Devuelve el plan de filas afectadas y TODAS las trabas en el orden
   * en que la llamada real las lanzaría.
   */
  private async planRegeneration(
    q: { query: (sql: string, params?: any[]) => Promise<any> },
    forUpdate: boolean,
    a: {
      courseId: number;
      ownerId: string;
      job: any;
      manifest: ManifestDto;
      mItem: { key: string; type: string; moduleId?: string | null; chapterId?: string | null };
      itemKey: string;
      videoMode: RunVideoMode;
      costKind: RegenerationCostKind;
      expectedGeneration?: number;
    },
  ): Promise<RegenerationPlan> {
    const lock = forUpdate ? ' for update' : '';
    const { job, manifest, mItem, itemKey, videoMode, costKind } = a;
    const blockers: RegenerationBlocker[] = [];
    const block = (code: string, message: string, error: () => Error) => blockers.push({ code, message, error });

    // Solo dryRun: el 403 de video real y el cancelado (que la llamada real lanza antes de la tx) como trabas.
    if (!forUpdate) {
      if (mItem.type === 'video' && videoMode === 'real') {
        try {
          assertRealVideoAllowed(a.ownerId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          block('real_video_not_allowed', msg, () => err as Error);
        }
      }
    }
    if (isCancelledLike(job)) {
      const msg = `La ejecución ${job.id} está cancelada; no se pueden regenerar items`;
      block('run_cancelled', msg, () => new ConflictException(msg));
    }

    const gens: any[] = await q.query(
      `select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc${lock}`,
      [job.id, itemKey],
    );
    if (gens.length === 0) {
      throw new InternalServerErrorException(`La ejecución ${job.id} no tiene filas para el item "${itemKey}" del Manifest (integridad rota)`);
    }
    const latest = gens[0];
    const currentGeneration = Number(latest.generation);
    // Idempotencia: la regeneración pedida sigue en vuelo → misma respuesta (antes que cualquier otra regla).
    if (latest.generation > 1 && REGENERATION_IN_FLIGHT.has(latest.status) && latest.output_summary?.regeneration && !isCancelledLike(job)) {
      return { inFlight: true, latest, currentGeneration, blockers: [], affected: this.storedAffected(latest, itemKey, costKind), cascade: [], staleDeps: [], staleArtifactIds: [], stale: false };
    }
    if (a.expectedGeneration !== undefined && a.expectedGeneration !== currentGeneration) {
      const message =
        `generation_changed: "${itemKey}" ya está en la generación ${currentGeneration} (esperabas la ${a.expectedGeneration}); ` +
        // El filtro global aplana el 409 a su mensaje: currentGeneration viaja también en el texto (como runId=).
        `actualiza la vista y confirma de nuevo. currentGeneration=${currentGeneration}`;
      block('generation_changed', message, () => new ConflictException({ message, code: 'generation_changed', currentGeneration }));
    }
    const superseding = await this.findSupersedingRun(q, job.id);
    if (superseding) {
      const err = this.supersededConflict(job.id, superseding);
      block('superseded_run', err.message, () => err);
    }
    const other = await this.findActiveRunOnOtherManifest(q, a.courseId, manifest.id);
    if (other) {
      const err = this.otherActiveRunConflict(other, manifest);
      block('active_run_on_other_manifest', err.message, () => err);
    }
    if (latest.status !== 'completed') {
      const message =
        `Solo se puede regenerar un item completado; "${itemKey}" (generation ${latest.generation}) está en "${latest.status}"` +
        (latest.status === 'failed' ? ' — usa retry para reintentarlo' : '');
      block('item_not_completed', message, () => new ConflictException({ message, code: 'item_not_completed' }));
    }
    const runActive = ACTIVE_RUN_WORKER_STATUSES.includes(String(job.worker_status));
    // EV6 DoD: `preview` es un run terminado igual que completed (se puede regenerar un item).
    if (!runActive && job.worker_status !== 'completed' && job.worker_status !== 'preview' && !isCancelledLike(job)) {
      const message = `La ejecución ${job.id} terminó en "${job.worker_status}"; reintenta sus items fallidos (retry) antes de regenerar otros`;
      block('run_not_regenerable', message, () => new ConflictException({ message, code: 'run_not_regenerable' }));
    }

    const staleArtifacts: Array<{ id: string }> = await q.query(
      `select id from public.artifacts where item_run_id = $1 and status = 'stale' order by id`,
      [latest.id],
    );
    const stale = staleArtifacts.length > 0 || latest.output_summary?.invalidation?.action === 'STALE_NO_AUTO';

    // Cascada (tabla de Fase 8 "editar el capítulo"; v3: regeneration-cascade.ts, fix round 1 I2).
    const { regenerate: cascadeKeys, stale: staleKeys } = regenerationCascade(
      manifest.rulesVersion,
      manifest.manifest.items,
      { key: itemKey, type: mItem.type, moduleId: mItem.moduleId ?? null, chapterId: mItem.chapterId ?? null },
    );
    const depKeys = [...cascadeKeys, ...staleKeys];
    const depRows: any[] = depKeys.length
      ? await q.query(
          `select * from public.generation_item_runs g
            where g.job_id = $1 and g.item_key = any($2::text[]) and ${latestGenerationPredicate('g')}
            order by g.item_key${lock}`,
          [job.id, depKeys],
        )
      : [];
    const depByKey = new Map(depRows.map((r) => [r.item_key, r]));
    for (const key of depKeys) {
      const r = depByKey.get(key);
      if (!r) throw new InternalServerErrorException(`La ejecución ${job.id} no tiene filas para "${key}" (integridad rota)`);
      if (r.status === 'running') {
        const message = `No se puede regenerar "${itemKey}" mientras "${key}" se está generando; reintenta cuando termine`;
        block('dependent_running', message, () => new ConflictException({ message, code: 'dependent_running' }));
      }
    }

    const affected: RegenerationAffectedItem[] = [
      { itemKey, type: mItem.type, itemRunId: null, generation: currentGeneration + 1, action: 'REGENERATE', created: true, costKind },
    ];
    const cascade: RegenerationPlan['cascade'] = [];
    for (const key of cascadeKeys) {
      const prev = depByKey.get(key);
      const depCost = regenerationCostKind(prev.type, videoMode);
      if (REGENERATION_IN_FLIGHT.has(prev.status) || prev.status === 'running') {
        affected.push({ itemKey: key, type: prev.type, itemRunId: prev.id, generation: Number(prev.generation), action: 'WAITS', created: false, costKind: depCost });
        continue;
      }
      cascade.push({ key, prev, costKind: depCost });
      affected.push({ itemKey: key, type: prev.type, itemRunId: null, generation: Number(prev.generation) + 1, action: 'REGENERATE', created: true, costKind: depCost });
    }
    const staleDeps: RegenerationPlan['staleDeps'] = [];
    for (const key of staleKeys) {
      const v = depByKey.get(key);
      const action: RegenerationAffectedItem['action'] =
        v.status === 'completed' ? 'STALE_NO_AUTO' : REGENERATION_IN_FLIGHT.has(v.status) || v.status === 'running' ? 'WAITS' : 'UNCHANGED';
      staleDeps.push({ key, row: v, action });
      affected.push({ itemKey: key, type: v.type, itemRunId: v.id, generation: Number(v.generation), action, created: false, costKind: 'none' });
    }
    return { inFlight: false, latest, currentGeneration, blockers, affected, cascade, staleDeps, staleArtifactIds: staleArtifacts.map((x) => x.id), stale };
  }

  /** Escrituras de una regeneración ya planificada y sin trabas (dentro de la tx, con locks). */
  private async applyRegeneration(
    qr: QueryRunner,
    plan: RegenerationPlan,
    a: { job: any; manifest: ManifestDto; itemKey: string; mItem: { type: string }; ownerId: string; costKind: RegenerationCostKind; attemptActor?: AttemptActor;
      autoRepair?: { code: string } },
  ): Promise<{ kind: 'created'; itemRunId: string; previousItemRunId: string; previousGeneration: number; affected: RegenerationAffectedItem[] }> {
    const { job, manifest, itemKey, ownerId, costKind } = a;
    const latest = plan.latest;
    const requestedAt = new Date().toISOString();
    const insertGeneration = async (prev: any, key: string, regeneration: Record<string, any>): Promise<{ id: string; generation: number }> => {
      const generation = Number(prev.generation) + 1;
      const [row] = await qr.query(
        `insert into public.generation_item_runs
           (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
            depends_on, idempotency_key, status, output_summary)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, 'pending', $12::jsonb)
         returning id`,
        [job.id, prev.course_id, prev.blueprint_id, prev.manifest_id, key, generation, prev.type,
          prev.module_id, prev.chapter_id, prev.depends_on ?? [], itemIdempotencyKey(manifest.id, key, generation),
          JSON.stringify({ regeneration })],
      );
      await recordItemReopened(qr, row.id, {
        actor: a.attemptActor ?? 'owner',
        strategy: regeneration.reason === PACKAGE_REPAIR_REASON ? 'package_repair:regenerate_targeted'
          : String(regeneration.reason).startsWith('cascade_from_') ? 'regenerate_cascade' : 'regenerate',
        automatic: regeneration.reason === PACKAGE_REPAIR_REASON,
      });
      // Fix wave M4 (tabla de Fase 8, fila REGENERATE): la salida de la
      // generación anterior pasa a stale con motivo — solo status + metadata
      // (el primer staleReason se conserva), nunca rutas ni filas.
      await qr.query(
        `update public.artifacts
            set status = 'stale',
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                  'staleReason', coalesce(metadata->>'staleReason', $2::text),
                  'supersededByItemRunId', $3::text, 'supersededAt', $4::text),
                updated_at = now()
          where item_run_id = $1 and status is distinct from 'disabled'`,
        [prev.id, String(regeneration.reason).startsWith('cascade_from_') ? regeneration.reason : 'regenerated', row.id, requestedAt],
      );
      return { id: row.id, generation };
    };

    const primary = await insertGeneration(latest, itemKey, {
      fromItemRunId: latest.id,
      fromGeneration: Number(latest.generation),
      reason: a.autoRepair ? PACKAGE_REPAIR_REASON : plan.stale ? 'stale_no_auto' : 'user_requested',
      ...(a.autoRepair ? { packageRepairCode: a.autoRepair.code } : {}),
      staleArtifactIds: plan.staleArtifactIds,
      costKind,
      requestedBy: ownerId,
      requestedAt,
    });
    const affected: RegenerationAffectedItem[] = plan.affected.map((x) => ({ ...x }));
    Object.assign(affected[0], { itemRunId: primary.id, generation: primary.generation });

    for (const c of plan.cascade) {
      const g = await insertGeneration(c.prev, c.key, {
        fromItemRunId: c.prev.id,
        fromGeneration: Number(c.prev.generation),
        reason: `cascade_from_${a.mItem.type}`,
        cascadeFromItemRunId: primary.id,
        cascadeFromItemKey: itemKey,
        staleArtifactIds: [],
        costKind: c.costKind,
        requestedBy: ownerId,
        requestedAt,
      });
      const entry = affected.find((x) => x.itemKey === c.key);
      Object.assign(entry, { itemRunId: g.id, generation: g.generation });
    }

    for (const dep of plan.staleDeps) {
      if (dep.action !== 'STALE_NO_AUTO') continue;
      const v = dep.row;
      const staleReason = `${a.mItem.type}_regenerated`;
      // STALE_NO_AUTO: el video queda como está (se sigue empaquetando, con
      // aviso) y la UI ofrece su regeneración paga explícita.
      await qr.query(
        `update public.artifacts
            set status = 'stale',
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                  'staleReason', $4::text, 'staleByItemRunId', $2::text, 'staleAt', $3::text),
                updated_at = now()
          where item_run_id = $1 and status is distinct from 'disabled'`,
        [v.id, primary.id, requestedAt, staleReason],
      );
      const prevInv = v.output_summary?.invalidation ?? {};
      // Fix wave M3: una cascada repetida conserva el previousAction ORIGINAL.
      const previousAction =
        prevInv.action === 'STALE_NO_AUTO' && Object.prototype.hasOwnProperty.call(prevInv, 'previousAction')
          ? prevInv.previousAction
          : prevInv.action ?? null;
      const invalidation = {
        ...prevInv,
        action: 'STALE_NO_AUTO',
        previousAction,
        reasons: [...new Set([...(Array.isArray(prevInv.reasons) ? prevInv.reasons : []), staleReason])],
        ...(a.mItem.type === 'content' ? { contentItemRunId: primary.id } : { sourceItemKey: itemKey, sourceItemRunId: primary.id }),
      };
      await qr.query(
        `update public.generation_item_runs
            set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('invalidation', $2::jsonb),
                updated_at = now()
          where id = $1`,
        [v.id, JSON.stringify(invalidation)],
      );
    }

    if (affected.length > 1) {
      await qr.query(
        `update public.generation_item_runs
            set output_summary = jsonb_set(output_summary, '{regeneration,cascade}', $2::jsonb)
          where id = $1`,
        [primary.id, JSON.stringify(affected)],
      );
    }

    const note = JSON.stringify({ itemKey, generation: primary.generation, itemRunId: primary.id, requestedAt, affected: affected.map((x) => x.itemKey) });
    const runActive = ACTIVE_RUN_WORKER_STATUSES.includes(String(job.worker_status));
    if (runActive) {
      await qr.query(
        `update public.production_jobs
            set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('lastRegeneration', $2::jsonb),
                updated_at = now()
          where id = $1`,
        [job.id, note],
      );
    } else {
      // Reabre el run completed para que el ejecutor reclame las generaciones nuevas.
      try {
        await qr.query(
          `update public.production_jobs
              set status = 'queued', worker_status = 'queued', finished_at = null, error_message = null,
                  next_retry_at = null,
                  output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('lastRegeneration', $2::jsonb),
                  updated_at = now()
            where id = $1`,
          [job.id, note],
        );
      } catch (err) {
        if (isActiveRunConflict(err)) {
          throw new ConflictException(`Ya hay otra ejecución activa para el Manifest #${manifest.id}; no se puede reabrir ${job.id}`);
        }
        throw err;
      }
    }
    return { kind: 'created', itemRunId: primary.id, previousItemRunId: latest.id, previousGeneration: Number(latest.generation), affected };
  }

  // ── EV6 T5 B2: «Generar videos reales» (upgrade de los videos pendientes del run) ──

  /**
   * Vista previa (SOLO lectura: no escribe estimados, aprobaciones ni generaciones) del upgrade de
   * los videos de vista previa del run actual a videos reales: qué videos (y sus interacciones) se
   * generarían, el estimado en USD de EXACTAMENTE eso, la decisión de aprobación y las trabas que la
   * confirmación respondería con 403/409. Si el run ya tiene un upgrade, lo devuelve (`upgrade`).
   */
  async previewVideoUpgrade(
    courseId: number,
    user: { id: string; email?: string | null },
    blueprintNumber: number,
    runId: string,
  ): Promise<VideoUpgradePreview> {
    // EV6 DoD (R5): herramienta de recuperación de admin; el estimado tampoco se muestra a un no admin.
    if (!isSuperAdminEmail(user.email)) {
      assertDynamicOwnerAllowed(user.id);
      throw adminRecoveryForbidden('Generar los videos reales de un curso');
    }
    // Fix round 1 (I2): un SUPER_ADMIN actúa sobre el run de CUALQUIER owner (el curso del cliente).
    const acting = { id: await this.ownerForActor(courseId, user.id, user), email: user.email };
    assertDynamicOwnerAllowed(acting.id);
    const manifest = await this.manifestOfRun(courseId, acting.id, blueprintNumber, runId);
    const job = await this.reconcileCancellation(await this.loadRunRow(courseId, manifest, runId));
    return this.videoUpgradePreviewOf(this.dataSource, courseId, acting, job, manifest);
  }

  /**
   * Fix round 1 (I2): owner efectivo para las herramientas de recuperación de admin. Un SUPER_ADMIN
   * actúa sobre el curso de cualquier owner (se resuelve el dueño real del curso; si no existe, el
   * 404 de siempre lo da manifestOfRun). Cualquier otro usuario: él mismo (ownership sin cambios).
   */
  async ownerForActor(courseId: number, actorId: string, actor?: { email?: string | null } | null): Promise<string> {
    if (!isSuperAdminEmail(actor?.email)) return actorId;
    const [c] = await this.dataSource.query(`select owner_id from public.courses where id = $1`, [courseId]);
    return c?.owner_id ? String(c.owner_id) : actorId;
  }

  /**
   * «Generar videos reales» (confirmación explícita). Re-valida TODO en el servidor y escribe en
   * UNA transacción (lock del curso + lock global del tope mensual): la aprobación del upgrade
   * (estimado scope regeneration + autorización ADMIN_APPROVED del run), una generación nueva
   * `pending` por cada video pendiente y su video_interactions, y el upgrade del run (videoMode
   * real, videoModeOriginal, videoUpgrade; run reabierto). Idempotente: si el run ya tiene un
   * upgrade (doble clic, dos pestañas, reintento tras un timeout) devuelve ESE (`created:false`)
   * sin escribir nada — nunca un segundo juego de generaciones pagas.
   */
  async confirmVideoUpgrade(
    courseId: number,
    user: { id: string; email?: string | null },
    blueprintNumber: number,
    runId: string,
    estimateHash: string,
  ): Promise<VideoUpgradeResult> {
    // EV6 DoD (R5): solo SUPER_ADMIN (antes de leer o escribir nada; también la respuesta idempotente).
    if (!isSuperAdminEmail(user.email)) {
      assertDynamicOwnerAllowed(user.id);
      throw new ForbiddenException({
        code: APPROVAL_FORBIDDEN,
        message: `${APPROVAL_FORBIDDEN}: generar los videos reales es una herramienta de recuperación de un administrador de Cursia. No se generó nada.`,
      });
    }
    // Fix round 1 (I2): el SUPER_ADMIN actúa sobre el run del dueño real del curso.
    const ownerId = await this.ownerForActor(courseId, user.id, user);
    assertDynamicOwnerAllowed(ownerId);
    const acting = { id: ownerId, email: user.email };
    const manifest = await this.manifestOfRun(courseId, ownerId, blueprintNumber, runId);
    const job = await this.reconcileCancellation(await this.loadRunRow(courseId, manifest, runId));
    const already = await this.existingUpgradeFor(this.dataSource, job, estimateHash);
    if (already) return { created: false, upgrade: already, run: await this.buildRunDto(job, manifest) };

    const pv = await this.videoUpgradePreviewOf(this.dataSource, courseId, acting, job, manifest, true);
    if (pv.upgradeInFlight && pv.upgrade) return { created: false, upgrade: pv.upgrade, run: await this.buildRunDto(await this.loadJobById(job.id), manifest) };
    if (pv._blockers && pv._blockers.length) throw pv._blockers[0].error();
    if (!pv.estimateHash || pv.estimateHash !== estimateHash) {
      throw new ConflictException({
        code: ESTIMATE_STALE,
        message: `${ESTIMATE_STALE}: el costo estimado cambió desde que lo viste (videos, precios, política o gasto); revisa el estimado nuevo. No se generó nada.`,
        preview: publicVideoUpgradePreview(pv),
      });
    }
    if (!pv.approval || !pv.approval.canApprove) {
      throw new ForbiddenException({
        code: APPROVAL_FORBIDDEN,
        message: `${APPROVAL_FORBIDDEN}: generar los videos reales requiere la autorización de un administrador (esperado USD ${pv.estimate?.expected}, máximo USD ${pv.estimate?.max}). No se generó nada.`,
      });
    }
    if (!pv.approval.withinPolicy) throw budgetBlockedConflict(pv.approval.blockedBy, publicVideoUpgradePreview(pv));
    // DN-1: los videos reales se publican en YouTube → preflight del dueño ANTES de escribir (hace red: fuera de la tx).
    await this.enforceVideoGate(ownerId, frozenRunVideoGate({ videoWork: pv.pendingVideos.length, videoMode: 'real', strategy: frozenVideoDeliveryOf(job.input_payload) }));

    const outcome = await this.tx(async (qr) => {
      await this.lockCourseRuns(qr, courseId);
      const [locked] = await qr.query(`select * from public.production_jobs where id = $1 for update`, [job.id]);
      const existing = await this.existingUpgradeFor(qr, locked, estimateHash);
      if (existing) return { kind: 'existing' as const, upgrade: existing };
      const plan = await this.planVideoUpgrade(qr, true, courseId, ownerId, locked, manifest);
      if (plan.blockers.length) throw plan.blockers[0].error();
      // Tope mensual compartido: una sola aprobación a la vez, con el plan recalculado acá.
      await qr.query(`select pg_advisory_xact_lock(hashtext($1))`, [MONTH_CAP_LOCK]);
      const econ = await this.videoUpgradeEconomics(qr, courseId, ownerId, locked, manifest, plan);
      if (econ.estimateHash !== estimateHash) {
        throw new ConflictException({
          code: ESTIMATE_STALE,
          message: `${ESTIMATE_STALE}: el costo o el gasto cambió mientras confirmabas; revisa el estimado nuevo. No se generó nada.`,
        });
      }
      if (!econ.plan.withinPolicy || !econ.plan.amount) throw budgetBlockedConflict(econ.plan.blockedBy);
      const rec = await this.finopsBudget!.recordRunUpgradeApproval(qr, {
        courseId, ownerId, manifestId: manifest.id, runId: locked.id, estimate: econ.estimate, amount: econ.plan.amount,
        runActual: econ.runActual, policyId: econ.policyId, approvedBy: String(user.email), fingerprint: estimateHash,
      });
      const requestedAt = new Date().toISOString();
      const upgrade: VideoUpgradeRecord = {
        id: randomUUID(),
        at: requestedAt,
        by: ownerId,
        confirmedBy: user.email ?? null,
        // Fix round 1 (I2): quién actuó (el admin) si no es el dueño del curso.
        ...(user.id !== ownerId ? { actedBy: user.id } : {}),
        estimateHash,
        itemKeys: plan.pending.map((r) => r.item_key).sort(),
        interactionKeys: [...plan.interactions, ...plan.questionsOnly.map((x) => x.interactions)].map((r) => r.item_key).sort(),
        estimateId: rec.estimateId,
        authorizationId: rec.authorizationId,
        amount: econ.plan.amount,
        authorizedRunBudget: rec.authorizedRunBudget,
      };
      const insertGeneration = async (prev: any, regeneration: Record<string, any>, carry: Record<string, any> = {}): Promise<string> => {
        const generation = Number(prev.generation) + 1;
        const [row] = await qr.query(
          `insert into public.generation_item_runs
             (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
              depends_on, idempotency_key, status, output_summary)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, 'pending', $12::jsonb)
           returning id`,
          [locked.id, prev.course_id, prev.blueprint_id, prev.manifest_id, prev.item_key, generation, prev.type,
            prev.module_id, prev.chapter_id, prev.depends_on ?? [], itemIdempotencyKey(manifest.id, prev.item_key, generation),
            JSON.stringify({ ...carry, regeneration })],
        );
        await qr.query(
          `update public.artifacts
              set status = 'stale',
                  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                    'staleReason', coalesce(metadata->>'staleReason', $2::text),
                    'supersededByItemRunId', $3::text, 'supersededAt', $4::text),
                  updated_at = now()
            where item_run_id = $1 and status is distinct from 'disabled'`,
          [prev.id, String(regeneration.reason), row.id, requestedAt],
        );
        return row.id as string;
      };
      const carriedKeys = new Set(plan.carried.map((r) => r.item_key));
      for (const prev of plan.pending) {
        // Un intento anterior (upgrade cancelado) que ya tenía un render REAL en Videogen: la generación
        // nueva reutiliza ese job (el worker lo vuelve a consultar; el ledger cobra una vez por job).
        const carry = carriedKeys.has(prev.item_key)
          ? { external: prev.output_summary.external, ...(prev.output_summary.externalReservationKey ? { externalReservationKey: prev.output_summary.externalReservationKey } : {}) }
          : {};
        const newId = await insertGeneration(prev, {
          reason: VIDEO_UPGRADE_REASON, upgradeId: upgrade.id, fromItemRunId: prev.id, fromGeneration: Number(prev.generation),
          costKind: carriedKeys.has(prev.item_key) ? 'none' : 'videogen', ...(carriedKeys.has(prev.item_key) ? { reusedVideogenJob: true } : {}),
          requestedBy: user.id, requestedAt,
        }, carry);
        const inter = plan.interactions.find((r) => r.chapter_id === prev.chapter_id);
        if (inter) {
          await insertGeneration(inter, {
            reason: VIDEO_UPGRADE_CASCADE_REASON, upgradeId: upgrade.id, fromItemRunId: inter.id, fromGeneration: Number(inter.generation),
            cascadeFromItemRunId: newId, cascadeFromItemKey: prev.item_key, costKind: 'llm', requestedBy: user.id, requestedAt,
          }, { sourceVideoItemRunId: newId });
        }
      }
      // I-3: preguntas de videos reales ya pagados (solo LLM): describen ESE video (sourceVideoItemRunId).
      for (const x of plan.questionsOnly) {
        await insertGeneration(x.interactions, {
          reason: VIDEO_UPGRADE_CASCADE_REASON, upgradeId: upgrade.id, fromItemRunId: x.interactions.id, fromGeneration: Number(x.interactions.generation),
          cascadeFromItemRunId: x.video.id, cascadeFromItemKey: x.video.item_key, costKind: 'llm', questionsOnly: true, requestedBy: user.id, requestedAt,
        }, { sourceVideoItemRunId: x.video.id });
      }
      const note = JSON.stringify({ kind: VIDEO_UPGRADE_REASON, upgradeId: upgrade.id, requestedAt, affected: [...upgrade.itemKeys, ...upgrade.interactionKeys] });
      try {
        await qr.query(
          `update public.production_jobs
              set input_payload = input_payload || jsonb_build_object('videoMode', 'real', 'videoModeOriginal', $2::text, 'videoUpgrade', $3::jsonb,
                                                                      'videoUpgradeHistory', $5::jsonb),
                  status = 'queued', worker_status = 'queued', finished_at = null, error_message = null, next_retry_at = null,
                  lease_until = null, worker_id = null,
                  output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('lastRegeneration', $4::jsonb),
                  updated_at = now()
            where id = $1`,
          [locked.id, locked.input_payload?.videoModeOriginal ?? this.videoModeOf(locked), JSON.stringify(upgrade), note,
            JSON.stringify(videoUpgradesOf(locked.input_payload))],
        );
      } catch (err) {
        if (isActiveRunConflict(err)) {
          throw new ConflictException(`Ya hay otra ejecución activa para el Manifest #${manifest.id}; no se puede reabrir ${locked.id}`);
        }
        throw err;
      }
      return { kind: 'created' as const, upgrade };
    });
    const fresh = await this.loadJobById(job.id);
    return {
      created: outcome.kind === 'created',
      upgrade: outcome.upgrade,
      run: await this.buildRunDto(fresh, manifest),
    };
  }

  /** Vista previa (con o sin las trabas internas para la confirmación). */
  private async videoUpgradePreviewOf(
    q: { query: (sql: string, params?: any[]) => Promise<any> },
    courseId: number,
    user: { id: string; email?: string | null },
    job: any,
    manifest: ManifestDto,
    keepInternals = false,
  ): Promise<VideoUpgradePreview> {
    const upgrade = videoUpgradeOf(job.input_payload);
    const upgradeInFlight = !!upgrade && (await this.upgradeInFlight(q, job));
    const base: VideoUpgradePreview = {
      runId: job.id, rulesVersion: manifest.rulesVersion, eligible: false, pendingVideos: [], interactions: [],
      estimate: null, approval: null, blockers: [], estimateHash: null, upgrade, upgradeInFlight,
    };
    // Un upgrade en vuelo: nada que confirmar (idempotencia). Uno terminado: se puede pedir otro para lo que quedó pendiente.
    if (upgradeInFlight) return base;
    const plan = await this.planVideoUpgrade(q, false, courseId, user.id, job, manifest);
    const blockers = [...plan.blockers];
    const out: VideoUpgradePreview = {
      ...base,
      pendingVideos: plan.pending.map((r) => ({
        itemKey: r.item_key, chapterId: r.chapter_id ?? null, generation: Number(r.generation),
        ...(plan.carried.some((c) => c.item_key === r.item_key) ? { reusesVideogenJob: true } : {}),
      })),
      interactions: plan.interactions.map((r) => ({ itemKey: r.item_key, generation: Number(r.generation) })),
    };
    out.questionsOnly = plan.questionsOnly.map((x) => ({ videoItemKey: x.video.item_key, itemKey: x.interactions.item_key, generation: Number(x.interactions.generation) }));
    out.needsReconciliation = plan.needsReconciliation.map((r) => ({ itemKey: r.item_key, chapterId: r.chapter_id ?? null }));
    if (plan.pending.length || plan.questionsOnly.length) {
      // DN-1 (después del 403 de video real, igual que la confirmación): YouTube conectado y verificado.
      // (Un video que reutiliza su job de Videogen igual se publica en YouTube: cuenta para el gate.)
      const gb = !plan.pending.length ? null : await this.videoGateBlocker(user.id, frozenRunVideoGate({ videoWork: plan.pending.length, videoMode: 'real', strategy: frozenVideoDeliveryOf(job.input_payload) }));
      if (gb) blockers.push({ code: gb.code, message: gb.message, error: () => new ConflictException({ message: gb.message, code: gb.code, ...(gb.reason ? { reason: gb.reason } : {}) }) });
      let econ: VideoUpgradeEconomics;
      try {
        econ = await this.videoUpgradeEconomics(q, courseId, user.id, job, manifest, plan);
      } catch (err) {
        throw this.finopsUnavailable(err);
      }
      const sum = estimateSummary(econ.estimate);
      out.estimate = {
        currency: sum.currency, min: sum.min, expected: sum.expected, max: sum.max,
        byProvider: sum.byProvider, byItemType: econ.estimate.totals.byItemType, byCategory: estimateCategories(sum.byProvider),
        breakdown: estimateBreakdown(econ.estimate),
      };
      out.approval = {
        // Video real = proveedor pagado real → siempre aprobación humana; nunca reutiliza un saldo autorizado antes.
        required: true,
        canApprove: isSuperAdminEmail(user.email),
        withinPolicy: econ.plan.withinPolicy,
        amount: econ.plan.amount,
        cappedByLimit: econ.plan.cappedByLimit,
        blockedBy: econ.plan.blockedBy,
        existing: null,
      };
      out.estimateHash = econ.estimateHash;
    }
    out.blockers = blockers.map((b) => ({ code: b.code, message: b.message }));
    out.eligible = blockers.length === 0 && (plan.pending.length > 0 || plan.questionsOnly.length > 0);
    if (keepInternals) out._blockers = blockers;
    return out;
  }

  /**
   * Planificador ÚNICO del upgrade (vista previa y confirmación). Solo lee; con `forUpdate`
   * (dentro de la tx, tras el lock del curso y el FOR UPDATE del run) bloquea las filas.
   */
  private async planVideoUpgrade(
    q: { query: (sql: string, params?: any[]) => Promise<any> },
    forUpdate: boolean,
    courseId: number,
    ownerId: string,
    job: any,
    manifest: ManifestDto,
  ): Promise<VideoUpgradePlan> {
    const lock = forUpdate ? ' for update' : '';
    const blockers: VideoUpgradeBlocker[] = [];
    const block = (code: string, message: string, error: () => Error) => blockers.push({ code, message, error });
    const conflict = (code: string, message: string) => () => new ConflictException({ message: `${code}: ${message}`, code });
    if (manifest.rulesVersion !== 3) {
      const m = 'generar los videos reales de un curso ya generado solo está disponible para la estructura actual (V2.1).';
      block(VIDEO_UPGRADE_NOT_ALLOWED_RULES, m, conflict(VIDEO_UPGRADE_NOT_ALLOWED_RULES, m));
      return { pending: [], interactions: [], blockers, carried: [], questionsOnly: [], needsReconciliation: [] };
    }
    try {
      assertRealVideoAllowed(ownerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      block('real_video_not_allowed', msg, () => err as Error);
    }
    // Terminado; o (fix round 1, I-1) terminado `failed`/`cancelled` SOLO por un upgrade anterior.
    // EV6 DoD: un run `preview` (terminado con videos de vista previa) se mejora igual que un completed con mocks.
    const finished = job.worker_status === 'completed' || job.worker_status === 'preview';
    const degraded = !finished && (await runIsUpgradeOnlyFailure(q, job));
    if ((isCancelledLike(job) && !degraded) || (!finished && !degraded)) {
      const m = `la generación del curso tiene que estar terminada para generar sus videos reales (estado: ${job.worker_status}).`;
      block(VIDEO_UPGRADE_RUN_NOT_READY, m, conflict(VIDEO_UPGRADE_RUN_NOT_READY, m));
    }
    const superseding = await this.findSupersedingRun(q, job.id);
    if (superseding) {
      const err = this.supersededConflict(job.id, superseding);
      block('superseded_run', err.message, () => err);
    }
    const other = await this.findActiveRunOnOtherManifest(q, courseId, manifest.id);
    if (other) {
      const err = this.otherActiveRunConflict(other, manifest);
      block('active_run_on_other_manifest', err.message, () => err);
    }
    const videos: any[] = await q.query(
      `select * from public.generation_item_runs g
        where g.job_id = $1 and g.type = 'video' and ${latestGenerationPredicate('g')}
        order by g.item_key${lock}`,
      [job.id],
    );
    const runMode = this.videoModeOf(job);
    const upgraded = upgradedVideoKeysOf(job.input_payload);
    const fallback = fallbackVideoModeOf(job.input_payload);
    const modeOf = (r: any) => r.output_summary?.mode;
    const isReal = (r: any) => modeOf(r) === 'real' || (modeOf(r) === undefined && fallback === 'real');
    // Ruling 6: en un run real, un video de vista previa solo es aceptable si un upgrade lo incluyó.
    const inconsistent = runMode === 'real'
      ? videos.filter((r) => r.status === 'completed' && modeOf(r) === 'mock' && !upgraded.has(r.item_key)).map((r) => r.item_key)
      : [];
    if (inconsistent.length) {
      const msg = videoModeInconsistentMessage(inconsistent, job.id);
      block(VIDEO_MODE_INCONSISTENT, msg, () => new ConflictException({ message: msg, code: VIDEO_MODE_INCONSISTENT, keys: inconsistent }));
    }
    const TERMINAL_NOT_DONE = new Set(['failed', 'blocked', 'cancelled']);
    const candidates = runMode !== 'real' && !upgraded.size
      ? videos.filter((r) => r.status === 'completed' && !isReal(r))
      // Tras un upgrade: solo videos de un upgrade que quedaron de vista previa o terminaron sin completar
      // (cancelados, fallidos o frenados por presupuesto — fix round 2, I-2).
      : videos.filter((r) => upgraded.has(r.item_key) &&
          ((r.status === 'completed' && modeOf(r) === 'mock') || (TERMINAL_NOT_DONE.has(r.status) && isUpgradeGeneration(r.output_summary))));
    // m-8 (fix round 2): un envío a Videogen que quedó ambiguo (sin id de job) nunca se reenvía a ciegas,
    // pero solo ESE video queda afuera (requiere revisión); el resto del upgrade sigue.
    const isAmbiguous = (r: any) => !!r.output_summary?.externalSubmitStartedAt && !r.output_summary?.external?.videogenJobId;
    const needsReconciliation = candidates.filter(isAmbiguous);
    const pending = candidates.filter((r) => !isAmbiguous(r));
    // Se reutiliza el job de Videogen de un intento anterior SOLO si su render no falló (cancelado,
    // frenado o falló DESPUÉS del render, p.ej. al publicar): se vuelve a consultar sin pagar de nuevo.
    // Un render FALLIDO o rechazado se estima y se envía como NUEVO (fix round 2, I-2).
    const renderFailed = (r: any) => /^(videogen_failed|videogen_submit_rejected)/.test(String(r.error ?? ''));
    const carried = pending.filter((r) => r.output_summary?.external?.videogenJobId &&
      (r.output_summary?.external?.mode === 'real' || r.output_summary?.mode === 'real') && !renderFailed(r));
    const hasItem = (k: string) => manifest.manifest.items.some((it) => it.key === k);
    const interKeys = pending.map((r) => `video_interactions:${r.chapter_id}`).filter(hasItem);
    // I-3 (fix round 2): un video REAL de un upgrade (ya pagado) cuyas preguntas NO son las suyas
    // (el upgrade se canceló antes) → se regeneran SOLO sus preguntas (LLM, sin costo de video).
    const realUpgraded = videos.filter((r) => upgraded.has(r.item_key) && r.status === 'completed' && modeOf(r) === 'real' &&
      isUpgradeGeneration(r.output_summary) && hasItem(`video_interactions:${r.chapter_id}`));
    const allInterKeys = [...new Set([...interKeys, ...realUpgraded.map((r) => `video_interactions:${r.chapter_id}`)])];
    const interRows: any[] = allInterKeys.length
      ? await q.query(
          `select * from public.generation_item_runs g
            where g.job_id = $1 and g.item_key = any($2::text[]) and ${latestGenerationPredicate('g')}
            order by g.item_key${lock}`,
          [job.id, allInterKeys],
        )
      : [];
    if (interRows.length !== allInterKeys.length) {
      throw new InternalServerErrorException(`La ejecución ${job.id} no tiene filas de video_interactions para todos sus videos (integridad rota)`);
    }
    const interByKey = new Map(interRows.map((r) => [r.item_key, r]));
    const interactions = interKeys.map((k) => interByKey.get(k));
    const questionsOnly: Array<{ video: any; interactions: any }> = [];
    for (const v of realUpgraded) {
      const ir = interByKey.get(`video_interactions:${v.chapter_id}`);
      // Fix round 3 (I-4): regla única de procedencia (sourceVideoItemRunId, o legacy por fecha).
      const own = questionsBelongToVideo({ id: v.id, finishedAt: v.finished_at }, { status: ir.status, outputSummary: ir.output_summary, finishedAt: ir.finished_at });
      const active = VIDEO_UPGRADE_IN_FLIGHT_STATES.includes(ir.status);
      if (!own && !active) questionsOnly.push({ video: v, interactions: ir });
    }
    // Solo lo que de verdad está generándose bloquea; una generación terminal de un upgrade (bloqueada
    // por presupuesto, fallida o cancelada) NO está «en curso» (fix round 2, I-2).
    for (const r of [...pending, ...interactions]) {
      const inFlight = r.status === 'running' || (REGENERATION_IN_FLIGHT.has(r.status) && !(r.status === 'blocked' && isUpgradeGeneration(r.output_summary)));
      if (inFlight) {
        const m = `"${r.item_key}" se está generando; espera a que termine.`;
        block('dependent_running', m, conflict('dependent_running', m));
      }
    }
    if (!pending.length && !questionsOnly.length && !inconsistent.length) {
      if (needsReconciliation.length) {
        const m = `el envío a Videogen de ${needsReconciliation.map((r) => r.item_key).join(', ')} quedó sin confirmar; hay que revisarlo antes de pedirlo de nuevo (nunca se envía a ciegas).`;
        block(VIDEO_UPGRADE_AMBIGUOUS_SUBMISSION, m, conflict(VIDEO_UPGRADE_AMBIGUOUS_SUBMISSION, m));
      } else {
        const m = 'este curso no tiene videos pendientes de generación.';
        block(VIDEO_UPGRADE_NOTHING_PENDING, m, conflict(VIDEO_UPGRADE_NOTHING_PENDING, m));
      }
    }
    const newVideoWork = pending.filter((r) => !carried.includes(r)).length;
    if (newVideoWork) {
      const missing = providerReadinessMissing({ providerModes: { presentation: 'mock', audio: 'mock' }, videoMode: 'real', videoCount: newVideoWork });
      if (missing.length) {
        const m = providerNotReadyMessage(missing);
        block(PROVIDER_NOT_READY, m, () => new ConflictException({ message: m, code: PROVIDER_NOT_READY, missing }));
      }
    }
    return { pending, interactions, blockers, carried, questionsOnly, needsReconciliation };
  }

  /** ¿Algún item del ÚLTIMO upgrade (video o interacciones) sigue en vuelo? */
  private async upgradeInFlight(q: { query: (sql: string, params?: any[]) => Promise<any> }, job: any): Promise<boolean> {
    const up = videoUpgradeOf(job?.input_payload);
    if (!up) return false;
    const keys = [...(up.itemKeys ?? []), ...(up.interactionKeys ?? [])];
    if (!keys.length) return false;
    const rows: any[] = await q.query(
      `select g.status from public.generation_item_runs g
        where g.job_id = $1 and g.item_key = any($2::text[]) and ${latestGenerationPredicate('g')}`,
      [job.id, keys],
    );
    return rows.some((r) => VIDEO_UPGRADE_IN_FLIGHT_STATES.includes(r.status));
  }

  /**
   * Idempotencia POR UPGRADE: la confirmación con la huella de un upgrade ya registrado (el último o
   * uno del historial) devuelve ESE; con un upgrade en vuelo, cualquier confirmación devuelve el que
   * está en vuelo. Si no → null (se puede planificar un upgrade nuevo con lo que quedó pendiente).
   */
  private async existingUpgradeFor(q: { query: (sql: string, params?: any[]) => Promise<any> }, job: any, estimateHash: string): Promise<VideoUpgradeRecord | null> {
    const all = videoUpgradesOf(job?.input_payload);
    const same = all.find((u) => u.estimateHash === estimateHash);
    if (same) return same;
    const last = videoUpgradeOf(job?.input_payload);
    if (last && (await this.upgradeInFlight(q, job))) return last;
    return null;
  }

  /** Estimado + plan de aprobación + huella del upgrade, todo sobre `runner` (la tx en la confirmación). */
  private async videoUpgradeEconomics(
    runner: { query: (sql: string, params?: any[]) => Promise<any> },
    courseId: number,
    ownerId: string,
    job: any,
    manifest: ManifestDto,
    plan: VideoUpgradePlan,
  ): Promise<VideoUpgradeEconomics> {
    if (!this.finopsBudget) {
      throw new ServiceUnavailableException({
        code: FINOPS_UNAVAILABLE,
        message: `${FINOPS_UNAVAILABLE}: no se puede estimar el costo de los videos reales; no se generó nada.`,
      });
    }
    const fb = this.finopsBudget;
    const modes = runSpendModes('real', frozenProviderModesOf(job.input_payload));
    const byKey = new Map(manifest.manifest.items.map((it) => [it.key, it]));
    const carried = new Set(plan.carried.map((r) => r.item_key));
    // Los videos que reutilizan su job de Videogen no tienen gasto nuevo de Videogen: fuera del estimado.
    const keys = [...plan.pending.filter((r) => !carried.has(r.item_key)), ...plan.interactions, ...plan.questionsOnly.map((x) => x.interactions)].map((r) => r.item_key);
    const items = keys.map((k) => byKey.get(k)).filter(Boolean) as RunManifestItem[];
    if (items.length !== keys.length) throw new InternalServerErrorException('upgrade de video: items fuera del Manifest (integridad rota)');
    const actions: Record<string, string> = {};
    for (const k of keys) actions[k] = 'REGENERATE';
    const estimateItems = estimateItemsForRun(items, modes, actions);
    const estimate = await fb.estimate(estimateItems, { runner });
    // En serie: `runner` puede ser la conexión de la tx (una consulta a la vez por conexión).
    const policy = await fb.policyFor(courseId, ownerId, runner);
    const spent = await fb.spentSoFar(courseId, runner);
    const month = await fb.monthCommitted(runner);
    const runActual = await fb.runActual(job.id, runner);
    const runPaidAuthorized = await fb.runPaidAuthorizedBudget(job.id, runner);
    const decision = decideRunBudget({ estimate, policy, spentSoFar: spent, paidRealProviders: paidRealProviders(estimateItems, modes) });
    let np = planNormalApproval({ estimate, policy, courseSpent: spent.course, monthSpent: month.total, providerSpent: spent.byProvider });
    if (decision.decision === 'BLOCK' && np.withinPolicy) {
      np = { ...np, withinPolicy: false, amount: null, cappedByLimit: null,
        blockedBy: [{ limit: 'policy_block', limitValue: null, spent: normalizeDecimal(spent.course), expected: estimate.totals.expected, over: 'expected' }] };
    }
    const estimateHash = videoUpgradeFingerprint({
      runId: job.id,
      manifestId: manifest.id,
      pending: plan.pending.map((r) => ({ itemKey: r.item_key, generation: Number(r.generation) })),
      interactions: plan.interactions.map((r) => ({ itemKey: r.item_key, generation: Number(r.generation) })),
      carried: [...carried].sort(),
      questionsOnly: plan.questionsOnly.map((x) => ({ itemKey: x.interactions.item_key, generation: Number(x.interactions.generation) })),
      modes,
      estimate,
      policyId: policy?.id ?? null,
      plan: { amount: np.amount, withinPolicy: np.withinPolicy },
      courseSpent: normalizeDecimal(spent.course),
      runActual: normalizeDecimal(runActual),
      runPaidAuthorized: runPaidAuthorized === null ? null : normalizeDecimal(runPaidAuthorized),
    });
    return { estimate, plan: np, policyId: policy?.id ?? null, runActual: normalizeDecimal(runActual), estimateHash };
  }

  // ── V2.1 RF-b: estimado + gates de presupuesto (audit §W.6/§W.7) ─────────

  /**
   * Estimado del run desde el Manifest (v1/v2/v3) + decisión de presupuesto.
   * - AUTO_WITHIN_POLICY → sigue (se vincula una autorización AUTO al crear el run).
   * - ADMIN_APPROVAL → exige una aprobación ADMIN_APPROVED de este curso para un
   *   estimado del MISMO Manifest, sin consumir y que cubra el esperado.
   * - BLOCK (política con on_exceed=BLOCK) → sin salida por aprobación.
   * Rechazo → BudgetGateRejection (el caller guarda el estimado FUERA de su tx y
   * responde 409 con el estimateId para que un admin lo autorice).
   */
  private async finopsEvaluate(a: {
    courseId: number;
    ownerId: string;
    manifestId: number;
    items: readonly RunManifestItem[];
    /** Modo de gasto por proveedor (video = videoMode; Gamma/TTS = providerModes congelados). */
    modes: RunSpendModes;
    actions?: Record<string, string> | null;
    runner?: { query: (sql: string, params?: any[]) => Promise<any> };
    planSha?: string | null;
    normalApproval?: NormalApprovalRequest;
  }): Promise<FinopsGate | null> {
    const mode = a.modes;
    if (!this.finopsBudget) {
      const paid = paidRealProviders(estimateItemsForRun(a.items, mode, a.actions ?? null), mode);
      if (paid.length > 0) {
        throw new ServiceUnavailableException({
          code: FINOPS_UNAVAILABLE,
          message: `${FINOPS_UNAVAILABLE}: no se puede evaluar el presupuesto de un run con proveedores pagados reales (${paid.join(', ')}); no se creó nada.`,
        });
      }
      return null;
    }
    let evaluation: StartBudgetEvaluation;
    try {
      evaluation = await this.finopsBudget.evaluateStart({
        courseId: a.courseId, ownerId: a.ownerId, mode, items: a.items, actions: a.actions ?? null,
      });
    } catch (err) {
      // Fail loud y cerrado: sin estimado no se crea ningún run (p.ej. precio
      // faltante en pricing_catalog o migración FinOps sin aplicar → 503 claro).
      throw this.finopsUnavailable(err);
    }
    if (evaluation.decision === 'BLOCK') throw new BudgetGateRejection(evaluation, BUDGET_BLOCKED, a.planSha ?? null);
    if (evaluation.decision === 'ADMIN_APPROVAL') {
      if (a.normalApproval) {
        // Flujo normal: el estimado de ESTE start tiene que ser el que vio el usuario; la aprobación
        // se escribe en la tx del run (finopsBindRun), nunca se reutiliza otra.
        const na = a.normalApproval;
        const t = evaluation.estimate.totals;
        if (cmpDec(t.expected, na.expected) !== 0 || cmpDec(t.max, na.max) !== 0) {
          throw new ConflictException({
            code: ESTIMATE_STALE,
            message: `${ESTIMATE_STALE}: el costo estimado cambió desde que lo viste (esperado ${na.expected} → ${t.expected}); revisa el estimado nuevo. No se creó nada.`,
          });
        }
        return { evaluation, approval: null, normalApproval: na };
      }
      const approval = await this.finopsBudget.findUnconsumedApproval(a.courseId, a.manifestId, evaluation.estimate.totals.expected, a.runner);
      if (!approval) throw new BudgetGateRejection(evaluation, BUDGET_APPROVAL_REQUIRED, a.planSha ?? null);
      return { evaluation, approval };
    }
    return { evaluation, approval: null };
  }

  /** FinopsError / tabla FinOps ausente → 503 finops_unavailable; cualquier otro error se relanza. */
  private finopsUnavailable(err: unknown): unknown {
    if (err instanceof FinopsError || pgCode(err) === '42P01') {
      const detail = err instanceof FinopsError ? `${err.code}: ${err.message}` : (err as Error).message;
      return new ServiceUnavailableException({
        code: FINOPS_UNAVAILABLE,
        message: `${FINOPS_UNAVAILABLE}: no se pudo estimar el costo de la generación (${detail}); no se creó nada.`,
      });
    }
    return err;
  }

  /** Camino de run nuevo (fuera de tx): evalúa y, si rechaza, guarda el estimado y responde 409. */
  private async finopsStartGate(a: {
    courseId: number;
    ownerId: string;
    manifestId: number;
    items: readonly RunManifestItem[];
    modes: RunSpendModes;
    normalApproval?: NormalApprovalRequest;
  }): Promise<FinopsGate | null> {
    try {
      return await this.finopsEvaluate(a);
    } catch (err) {
      if (err instanceof BudgetGateRejection) {
        throw await this.budgetRejection(err.evaluation, err.code, { courseId: a.courseId, ownerId: a.ownerId, manifestId: a.manifestId, planSha: null });
      }
      throw err;
    }
  }

  /** Guarda el estimado rechazado (sin run) y arma el 409 con sus totales. */
  private async budgetRejection(
    evaluation: StartBudgetEvaluation,
    code: string,
    ctx: { courseId: number; ownerId: string; manifestId: number; planSha: string | null },
  ): Promise<ConflictException> {
    const est = await this.finopsBudget!.recordEstimate({
      scope: 'run', ownerId: ctx.ownerId, courseId: ctx.courseId, manifestId: ctx.manifestId, runId: null,
      invalidationPlanSha: ctx.planSha, estimate: evaluation.estimate,
    });
    return this.budgetConflict(code, est.id, evaluation.estimate, evaluation.reasons, evaluation.paidRealProviders);
  }

  private budgetConflict(code: string, estimateId: string, estimate: EstimateResult, reasons: string[], providers: string[]): ConflictException {
    const totals = estimateSummary(estimate);
    const human = code === BUDGET_BLOCKED
      ? 'la política de presupuesto bloquea esta generación (supera el límite configurado); un administrador tiene que cambiar la política.'
      : 'esta generación requiere la aprobación de un administrador antes de gastar en proveedores pagados.';
    // El filtro global aplana el 409 a su mensaje: estimateId y totales viajan también en el texto.
    const message =
      `${code}: ${human} No se creó ni se envió nada. estimateId=${estimateId} ` +
      `totalsJson=${JSON.stringify({ currency: totals.currency, min: totals.min, expected: totals.expected, max: totals.max })}`;
    return new ConflictException({ message, code, estimateId, estimate: totals, reasons, paidRealProviders: providers });
  }

  /** Dentro de la tx que crea el run: estimado con run_id + autorización del run (consumiendo la aprobación). */
  private async finopsBindRun(
    qr: QueryRunner,
    gate: FinopsGate | null,
    a: { runId: string; courseId: number; ownerId: string; manifestId: number; planSha?: string | null },
  ): Promise<void> {
    if (!gate || !this.finopsBudget) return;
    if (gate.normalApproval) {
      // Flujo normal: la aprobación nace en ESTA tx (con el run). Lock global del tope mensual y plan
      // recalculado sobre la tx: si otra aprobación ya se llevó el remanente, o cambió el monto, no se escribe nada.
      const na = gate.normalApproval;
      await qr.query(`select pg_advisory_xact_lock(hashtext($1))`, [MONTH_CAP_LOCK]);
      const np = await this.normalPlan(qr, a.courseId, a.ownerId, gate.evaluation);
      if (!np.plan.withinPolicy) throw budgetBlockedConflict(np.plan.blockedBy);
      if (cmpDec(np.plan.amount!, na.amount) !== 0) {
        throw new ConflictException({
          code: ESTIMATE_STALE,
          message: `${ESTIMATE_STALE}: el monto a autorizar cambió (${na.amount} → ${np.plan.amount}) por gasto o aprobaciones nuevas; revisa el estimado nuevo. No se creó nada.`,
        });
      }
      const rec = await this.finopsBudget.recordNormalApproval(qr, {
        courseId: a.courseId, ownerId: a.ownerId, manifestId: a.manifestId, estimate: gate.evaluation.estimate, amount: na.amount,
        policyId: gate.evaluation.policyId, approvedBy: na.approvedBy, fingerprint: na.fingerprint,
      });
      gate = { ...gate, approval: { id: rec.authorizationId, estimate_id: rec.estimateId, authorized_budget: na.amount, approved_by: na.approvedBy, policy_id: gate.evaluation.policyId } };
      na.result = { authorizationId: rec.authorizationId, amount: na.amount };
    }
    if (gate.approval) {
      const [used] = await qr.query(
        `select id from public.cost_budget_authorizations where estimate_id = $1 and run_id is not null limit 1`,
        [gate.approval.estimate_id],
      );
      if (used) {
        throw new ConflictException({
          message: `${BUDGET_APPROVAL_REQUIRED}: la aprobación ${gate.approval.id} ya se usó en otra ejecución; pide una nueva. No se creó nada.`,
          code: BUDGET_APPROVAL_REQUIRED,
        });
      }
    }
    await this.finopsBudget.bindRun(qr, {
      runId: a.runId, courseId: a.courseId, ownerId: a.ownerId, manifestId: a.manifestId,
      evaluation: gate.evaluation, approval: gate.approval, invalidationPlanSha: a.planSha ?? null,
    });
  }

  /**
   * Run B desde un plan (ya commiteado): una fila de cost_avoidance_events por
   * REUSE/REVIEW/STALE_NO_AUTO (historical actual first, HD-V21-18). Contable:
   * un fallo se loguea fuerte pero no deshace el run.
   */
  private async finopsRecordAvoidance(job: any, manifest: ManifestDto, plan: { actions: any[] }): Promise<void> {
    if (!this.finopsBudget) return;
    try {
      const keep = plan.actions.filter((x) => x.inTargetManifest && ['REUSE', 'REVIEW', 'STALE_NO_AUTO'].includes(x.action));
      if (keep.length === 0) return;
      const mode = this.spendModesOf(job);
      const byKey = new Map(manifest.manifest.items.map((it) => [it.key, it]));
      const items = keep.map((x) => byKey.get(x.itemKey)).filter(Boolean) as RunManifestItem[];
      const est = await this.finopsBudget.estimate(estimateItemsForRun(items, mode, null));
      const hist = await this.finopsBudget.historicalByItemRun(keep.map((x) => x.fromItemRunId).filter(Boolean));
      const withBasis = keep.filter((x) => (x.fromItemRunId && (hist[x.fromItemRunId] || []).length > 0) || est.lines.some((l) => l.itemKey === x.itemKey));
      const r = incrementalCostForPlan(withBasis.map((x) => ({ itemKey: x.itemKey, action: x.action, fromItemRunId: x.fromItemRunId })), est.lines, hist);
      for (const act of r.actions) {
        if (!act.basis) continue;
        await this.finopsBudget.recordAvoidance({
          runId: job.id, courseId: Number(job.course_id), manifestId: manifest.id, itemKey: act.itemKey,
          action: act.action as 'REUSE' | 'REVIEW' | 'STALE_NO_AUTO', sourceItemRunId: act.sourceItemRunId, basis: act.basis,
          avoidedAmount: act.avoided, sourceChargeEventIds: act.sourceChargeEventIds,
        });
      }
    } catch (err) {
      this.logger.error(`finops: no se pudo registrar el costo evitado del run ${job.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** dryRun de regenerateItem: incremental (min/esperado/max) y evitado por item afectado. */
  private async regenerationCostPreview(
    manifest: ManifestDto,
    affected: RegenerationAffectedItem[],
    modes: RunSpendModes,
  ): Promise<RegenerationCostPreview | null> {
    if (!this.finopsBudget) return null;
    const zero = normalizeDecimal(0);
    const zeros: MinExpMax = { min: zero, expected: zero, max: zero };
    const mode = modes;
    const byKey = new Map(manifest.manifest.items.map((it) => [it.key, it]));
    const planned = affected.filter((x) => x.action === 'REGENERATE' || x.action === 'STALE_NO_AUTO');
    const actions: Record<string, string> = {};
    for (const x of planned) actions[x.itemKey] = x.action;
    const items = planned.map((x) => byKey.get(x.itemKey)).filter(Boolean) as RunManifestItem[];
    const est = await this.finopsBudget.estimate(estimateItemsForRun(items, mode, actions, { coverageItems: manifest.manifest.items }));
    const sourceIds = planned.filter((x) => x.action === 'STALE_NO_AUTO' && x.itemRunId).map((x) => x.itemRunId as string);
    const hist = await this.finopsBudget.historicalByItemRun(sourceIds);
    const computable = planned.filter(
      (x) => est.lines.some((l) => l.itemKey === x.itemKey) || (x.itemRunId && (hist[x.itemRunId] || []).length > 0),
    );
    const r = incrementalCostForPlan(
      computable.map((x) => ({ itemKey: x.itemKey, action: x.action, fromItemRunId: x.action === 'STALE_NO_AUTO' ? x.itemRunId : null })),
      est.lines,
      hist,
    );
    const byItemKey = new Map(r.actions.map((x) => [x.itemKey, x]));
    return {
      currency: est.currency,
      incrementalCost: r.totals.incremental,
      avoided: r.totals.avoided,
      byItem: affected.map((x) => {
        const c = byItemKey.get(x.itemKey);
        return {
          itemKey: x.itemKey,
          action: x.action,
          incrementalCost: c ? c.incremental : zeros,
          avoided: c ? c.avoided : zero,
          avoidedBasis: c ? c.basis : null,
        };
      }),
    };
  }

  /**
   * RF-b fix I1: gate de trabajo pagado REAL nuevo sobre un run existente
   * (retry / resubmitVideo / reopen). Estimado de esos items (scope regeneration,
   * con run_id) y exige que la última aprobación ADMIN_APPROVED del run cubra
   * actual + incremental esperado; si no → 409 budget_approval_required con el
   * estimateId. AUTO_WITHIN_POLICY nunca cubre proveedores pagados.
   */
  /**
   * r19 (A5): palabras narrables de cada capítulo cuyo audiolibro se va a (re)generar, si ya se conocen: el plan
   * de bloques (`audiobookPlan.narratableWords`) del item de audiolibro más reciente de ese capítulo en el run.
   * Solo existe en un reintento/regeneración de un audiolibro ya planificado; antes de la primera generación el
   * contenido no existe y el estimado usa el capítulo de referencia (2.800 palabras). Nunca falla el gate: ante
   * cualquier error devuelve {} (el estimado de referencia).
   */
  private async audiobookChapterWords(runId: string, items: readonly RunManifestItem[]): Promise<Record<string, number>> {
    const chapterIds = [...new Set(items.filter((it) => it.type === 'audiobook_chapter' && it.chapterId).map((it) => it.chapterId as string))];
    if (!chapterIds.length) return {};
    try {
      const rows: Array<{ chapter_id: string; words: string | null }> = await this.dataSource.query(
        `select distinct on (chapter_id) chapter_id::text as chapter_id, output_summary->'audiobookPlan'->>'narratableWords' as words
           from public.generation_item_runs
          where job_id = $1 and type = 'audiobook_chapter' and chapter_id::text = any($2::text[])
            and output_summary ? 'audiobookPlan'
          order by chapter_id, generation desc`,
        [runId, chapterIds],
      );
      const out: Record<string, number> = {};
      for (const r of rows) {
        const w = Number(r.words);
        if (Number.isFinite(w) && w > 0) out[r.chapter_id] = w;
      }
      return out;
    } catch (err) {
      this.logger.warn(`finops: palabras del audiolibro no disponibles para el estimado (${err instanceof Error ? err.message : String(err)}); se usa el capítulo de referencia`);
      return {};
    }
  }

  private async finopsPaidWorkGate(a: { courseId: number; ownerId: string; manifest: ManifestDto; job: any; paidKeys: string[]; dryRun?: boolean }): Promise<void> {
    // Solo los items cuyo proveedor está congelado en `real` para este run (video: videoMode; Gamma/TTS: providerModes).
    const modes = this.spendModesOf(a.job);
    const typeOf = new Map(a.manifest.manifest.items.map((it) => [it.key, it.type]));
    const keys = [...new Set(a.paidKeys)].filter((k) => spendModeOfItemType(modes, String(typeOf.get(k))) === 'real').sort();
    if (keys.length === 0) return;
    if (!this.finopsBudget) {
      throw new ServiceUnavailableException({
        code: FINOPS_UNAVAILABLE,
        message: `${FINOPS_UNAVAILABLE}: no se puede evaluar el presupuesto de trabajo pagado real (${keys.join(', ')}); no se reintentó nada.`,
      });
    }
    const byKey = new Map(a.manifest.manifest.items.map((it) => [it.key, it]));
    const items = keys.map((k) => byKey.get(k)).filter(Boolean) as RunManifestItem[];
    const actions: Record<string, string> = {};
    for (const it of items) actions[it.key] = 'REGENERATE';
    let estimate: EstimateResult;
    try {
      const chapterWords = await this.audiobookChapterWords(a.job.id, items);
      estimate = await this.finopsBudget.estimate(estimateItemsForRun(items, 'real', actions, { chapterWords, coverageItems: a.manifest.manifest.items }));
    } catch (err) {
      throw this.finopsUnavailable(err);
    }
    const [authorizedBudget, actualSoFar] = await Promise.all([
      this.finopsBudget.runPaidAuthorizedBudget(a.job.id),
      this.finopsBudget.runActual(a.job.id),
    ]);
    const g = runtimeGuard({ authorizedBudget, actualSoFar, reservedInFlight: '0', next: estimate.totals.expected });
    if (g.allow) return;
    if (a.dryRun) {
      // R16 (#2): el auto-healer no registra estimados (correría en cada barrido): el item queda para un humano.
      throw new ConflictException({
        code: BUDGET_APPROVAL_REQUIRED,
        message: `${BUDGET_APPROVAL_REQUIRED}: reabrir ${keys.join(', ')} excede el presupuesto autorizado (${g.reason}); no se reabre automáticamente.`,
      });
    }
    const est = await this.finopsBudget.recordEstimate({
      scope: 'regeneration', ownerId: a.ownerId, courseId: a.courseId, manifestId: a.manifest.id, runId: a.job.id, estimate,
    });
    const providers = [...new Set(items.map((it) => paidProviderOfItemType(it.type)).filter(Boolean) as string[])].sort();
    throw this.budgetConflict(BUDGET_APPROVAL_REQUIRED, est.id, estimate, [
      `${g.reason}(committed=${g.committed},authorized=${authorizedBudget ?? 'none'})`,
    ], providers);
  }

  /**
   * Regeneración real: guarda el estimado (scope regeneration, con run_id) y,
   * si regenera con un proveedor pagado REAL, exige que el presupuesto
   * autorizado del run cubra actual + incremental esperado; si no → 409
   * budget_approval_required con el estimateId (un admin lo autoriza con el
   * nuevo presupuesto TOTAL del run y se reintenta).
   */
  private async finopsRegenerationGate(
    courseId: number,
    ownerId: string,
    manifest: ManifestDto,
    job: any,
    mItem: { key: string; type: string; moduleId?: string | null; chapterId?: string | null },
    itemKey: string,
    videoMode: RunVideoMode,
  ): Promise<void> {
    const plan = await this.planRegeneration(this.dataSource, false, {
      courseId, ownerId, job, manifest, mItem, itemKey, videoMode, costKind: regenerationCostKind(mItem.type, videoMode),
    });
    // Idempotencia en vuelo o trabas: la tx responde lo de siempre, sin estimado nuevo.
    if (plan.inFlight || plan.blockers.length > 0) return;
    const mode = this.spendModesOf(job);
    const regenerated = plan.affected.filter((x) => x.action === 'REGENERATE');
    const paid = [...new Set(regenerated
      .filter((x) => spendModeOfItemType(mode, x.type) === 'real')
      .map((x) => paidProviderOfItemType(x.type)).filter(Boolean) as string[])].sort();
    if (!this.finopsBudget) {
      if (paid.length > 0) {
        throw new ServiceUnavailableException({
          code: FINOPS_UNAVAILABLE,
          message: `${FINOPS_UNAVAILABLE}: no se puede evaluar el presupuesto de una regeneración con proveedores pagados reales (${paid.join(', ')}).`,
        });
      }
      return;
    }
    const byKey = new Map(manifest.manifest.items.map((it) => [it.key, it]));
    const actions: Record<string, string> = {};
    for (const x of regenerated) actions[x.itemKey] = 'REGENERATE';
    const items = regenerated.map((x) => byKey.get(x.itemKey)).filter(Boolean) as RunManifestItem[];
    let estimate: EstimateResult;
    try {
      const chapterWords = await this.audiobookChapterWords(job.id, items);
      estimate = await this.finopsBudget.estimate(estimateItemsForRun(items, mode, actions, { chapterWords, coverageItems: manifest.manifest.items }));
    } catch (err) {
      throw this.finopsUnavailable(err);
    }
    const est = await this.finopsBudget.recordEstimate({
      scope: 'regeneration', ownerId, courseId, manifestId: manifest.id, runId: job.id, estimate,
    });
    if (paid.length === 0) return;
    // RF-b fix I1: solo una aprobación ADMIN_APPROVED cubre proveedores pagados (nunca AUTO).
    const [authorizedBudget, actualSoFar] = await Promise.all([
      this.finopsBudget.runPaidAuthorizedBudget(job.id),
      this.finopsBudget.runActual(job.id),
    ]);
    const g = runtimeGuard({ authorizedBudget, actualSoFar, reservedInFlight: '0', next: estimate.totals.expected });
    if (!g.allow) {
      throw this.budgetConflict(BUDGET_APPROVAL_REQUIRED, est.id, estimate, [
        `${g.reason}(committed=${g.committed},authorized=${authorizedBudget ?? 'none'},actual=${addDec(actualSoFar, 0)})`,
      ], paid);
    }
  }

  // ── DN-1: gate de entrega de video ──────────────────────────────────────

  /** Review DN-1 M6: 409 si `youtubeVideoId` ya está registrado en otro item (generación vigente) del run. */
  private async assertYoutubeIdUnused(
    q: { query: (sql: string, params?: any[]) => Promise<any> },
    jobId: string,
    itemKey: string,
    youtubeVideoId: string,
  ): Promise<void> {
    const rows: Array<{ item_key: string }> = await q.query(
      `select g.item_key from public.generation_item_runs g
        where g.job_id = $1 and g.item_key <> $2 and ${latestGenerationPredicate('g')}
          and (g.output_summary->'external'->>'youtubeVideoId' = $3 or g.output_summary->>'youtubeVideoId' = $3)`,
      [jobId, itemKey, youtubeVideoId],
    );
    if (rows.length > 0) {
      throw new ConflictException({
        message:
          `${YOUTUBE_VIDEO_NOT_VERIFIED}:video_already_used: ese video de YouTube ya está asignado a otro video de este curso ` +
          `(${rows.map((r) => r.item_key).join(', ')}). No se registró nada.`,
        code: YOUTUBE_VIDEO_NOT_VERIFIED,
        reason: 'video_already_used',
      });
    }
  }

  private videoCountOf(manifest: ManifestDto): number {
    return manifest.manifest.items.filter((it) => it.type === 'video').length;
  }

  /**
   * Items `video` (generación vigente) en `statuses` que, si vuelven a
   * pending, ENVIARÍAN un video nuevo a Videogen: los que no tienen un job
   * registrado (`external.videogenJobId`). Un video en fase de subida o con
   * job ya enviado se re-pollea/re-sube sin gasto de Videogen.
   */
  private async videoSubmissionsIfReopened(
    q: { query: (sql: string, params?: any[]) => Promise<any> },
    jobId: string,
    statuses: string[],
    /** EV6 T5 B2: la reapertura no re-encola generaciones de un upgrade de video. */
    excludeUpgrade = false,
  ): Promise<number> {
    const rows: Array<{ output_summary: Record<string, any> | null }> = await q.query(
      `select g.output_summary from public.generation_item_runs g
        where g.job_id = $1 and g.type = 'video' and g.status = any($2::text[]) and ${latestGenerationPredicate('g')}`,
      [jobId, statuses],
    );
    return rows.filter((r) => !r.output_summary?.external?.videogenJobId && !(excludeUpgrade && isUpgradeGeneration(r.output_summary))).length;
  }

  /** Preflight de YouTube del servidor; sin el servicio (harness) → falla cerrado. */
  private async serverYoutubePreflight(ownerId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.youtubePreflight) return { ok: false, reason: 'preflight_unavailable' };
    try {
      const r: YoutubePreflightResult = await this.youtubePreflight.check(ownerId);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'channel_unresolved' };
    } catch (err) {
      // Error inesperado (DB, config): nunca se deja pasar un run con gasto.
      this.logger.warn(`preflight de YouTube falló con error inesperado para owner=${ownerId}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'preflight_unavailable' };
    }
  }

  /** Traba del gate (o null): mismo criterio que enforceVideoGate, sin lanzar (dryRun). */
  private async videoGateBlocker(ownerId: string, gate: VideoDeliveryGateResult): Promise<{ code: string; message: string; reason?: string } | null> {
    if (gate.ok === false) return { code: gate.code, message: gate.message };
    if (!gate.requiresYoutubePreflight) return null;
    const pre = await this.serverYoutubePreflight(ownerId);
    if (pre.ok) return null;
    return { code: YOUTUBE_PREFLIGHT_FAILED, message: youtubePreflightFailedMessage(pre.reason as string), reason: pre.reason };
  }

  /**
   * DN-1: 409 `video_delivery_not_youtube` o `youtube_preflight_failed:<reason>`
   * si el camino va a enviar video real sin una entrega YouTube verificada.
   * Se llama SIEMPRE antes de cualquier escritura del camino.
   */
  private async enforceVideoGate(ownerId: string, gate: VideoDeliveryGateResult): Promise<void> {
    const b = await this.videoGateBlocker(ownerId, gate);
    if (b) throw new ConflictException({ message: b.message, code: b.code, ...(b.reason ? { reason: b.reason } : {}) });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Manifest congelado de un run (input_payload.manifestId), no el "actual"
   * de la config: un run v1 sigue siendo legible/cancelable/reintentable
   * aunque DYNAMIC_MANIFEST_RULES_VERSION pase a 2 (y viceversa). Ownership,
   * `dynamic` y pertenencia al Blueprint se verifican en
   * GenerationManifestsService.getById. Si el run no existe para este curso:
   * 404/400 del Blueprint (ajeno/legacy) o 404 del run — nunca se consulta
   * la config (fix wave review-rv2).
   */
  private async manifestOfRun(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<ManifestDto> {
    const [row] = await this.dataSource.query(
      `select input_payload->>'manifestId' as manifest_id from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation' and course_id = $2`,
      [runId, courseId],
    );
    const manifestId = Number(row?.manifest_id);
    if (!row || !Number.isInteger(manifestId)) {
      // Run inexistente para este curso: mismos 404/400 del Blueprint de
      // siempre, pero SIN leer el Manifest de la config (un run se resuelve
      // solo por su propio manifestId; la config nunca decide, fix wave
      // review-rv2) y con el 404 del run.
      await this.manifests.assertBlueprintAccessible(courseId, ownerId, blueprintNumber);
      throw new NotFoundException(`La ejecución ${runId} no existe para el Blueprint v${blueprintNumber} del curso #${courseId}`);
    }
    return this.manifests.getById(courseId, ownerId, blueprintNumber, manifestId);
  }

  /**
   * Inserta job + contexto + items (dentro de la transacción del caller).
   * Items: INSERT … ON CONFLICT (manifest_id, item_key, generation) DO
   * NOTHING, en el orden del Manifest. Si no se insertaron TODOS (alguno ya
   * existía de otro run) → 409 y rollback: nunca un run con items ajenos.
   */
  private async insertRun(
    qr: QueryRunner,
    manifest: ManifestDto,
    ownerId: string,
    courseId: number,
    frontendCourseId: string | null,
    blueprintNumber: number,
    context: Record<string, any>,
    contextHash: string,
    videoMode: RunVideoMode,
    videoDelivery: VideoDeliveryStrategy,
    providerModes?: ProviderModes,
  ): Promise<string> {
    // I1: bajo el lock del curso, ningún otro Manifest del curso puede tener
    // un run activo (el índice único parcial solo protege ESTE Manifest).
    await this.lockCourseRuns(qr, courseId);
    const other = await this.findActiveRunOnOtherManifest(qr, courseId, manifest.id);
    if (other) throw this.otherActiveRunConflict(other, manifest);

    // v1/v2: sin providerModes (input_payload idéntico al de antes); v3: congelados (fix round 1, I1).
    const inputPayload = { manifestId: manifest.id, blueprintNumber, contextHash, videoMode, videoDelivery, ...(providerModes ? { providerModes } : {}) };
    const [job] = await qr.query(
      `insert into public.production_jobs
         (owner_id, course_id, frontend_course_id, execution_mode, status, worker_status, current_step,
          progress, blueprint_version_id, input_payload, output_summary, options, result,
          lease_until, worker_id, created_at, updated_at)
       values ($1, $2, $3, 'dynamic_generation', 'queued', 'queued', 'dynamic_generation',
               0, $4, $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               null, null, now(), now())
       returning id`,
      [ownerId, courseId, frontendCourseId, manifest.blueprintId, JSON.stringify(inputPayload)],
    );

    await qr.query(
      `insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash)
       values ($1, $2, $3::jsonb, $4)`,
      [job.id, manifest.id, JSON.stringify(context), contextHash],
    );

    const items = manifest.manifest.items;
    const params: any[] = [];
    const values = items.map((it) => {
      const b = params.length;
      params.push(
        job.id, courseId, manifest.blueprintId, manifest.id, it.key, GENERATION, it.type, it.moduleId,
        it.chapterId, it.dependsOn, itemIdempotencyKey(manifest.id, it.key, GENERATION),
      );
      return `($${b + 1}::uuid, $${b + 2}::int, $${b + 3}::int, $${b + 4}::int, $${b + 5}, $${b + 6}::int, ` +
        `$${b + 7}, $${b + 8}::uuid, $${b + 9}::uuid, $${b + 10}::text[], $${b + 11}, 'pending')`;
    });
    const inserted = await qr.query(
      `insert into public.generation_item_runs
         (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id,
          chapter_id, depends_on, idempotency_key, status)
       values ${values.join(', ')}
       on conflict (manifest_id, item_key, generation) do nothing
       returning id`,
      params,
    );
    const insertedCount = Array.isArray(inserted) ? inserted.length : 0;
    if (insertedCount === items.length && insertedCount !== manifest.totals.totalJobs) {
      // Falla fuerte ANTES del commit: nada queda escrito.
      throw new InternalServerErrorException(
        `Manifest #${manifest.id}: se sembraron ${insertedCount} items pero totals.totalJobs = ${manifest.totals.totalJobs}`,
      );
    }
    if (insertedCount !== items.length) {
      throw new ConflictException(
        `El Manifest #${manifest.id} ya tiene items sembrados de otra ejecución ` +
          `(${Array.isArray(inserted) ? inserted.length : 0}/${items.length} nuevos); usar reintentar items`,
      );
    }
    return job.id;
  }

  private async hasPreviousItems(manifest: ManifestDto): Promise<boolean> {
    const [{ n }] = await this.dataSource.query(
      `select count(*)::int as n from public.generation_item_runs where manifest_id = $1 and generation = $2`,
      [manifest.id, GENERATION],
    );
    return n > 0;
  }

  private async assertNoPreviousItems(manifest: ManifestDto): Promise<void> {
    if (await this.hasPreviousItems(manifest)) {
      throw new ConflictException(
        `Ya existe una ejecución terminada para este Manifest (#${manifest.id}); usar reintentar items ` +
          '(re-ejecutar un Manifest completo es regeneración, fuera de 5A)',
      );
    }
  }

  private async existingRunOrConflict(
    job: any,
    manifest: ManifestDto,
    contextHash: string,
    videoMode: RunVideoMode,
    providerModes?: ProviderModes,
  ): Promise<StartRunResult> {
    const ctx = await this.loadContextRow(job.id);
    if (ctx.context_hash !== contextHash) {
      throw new ConflictException(
        'Ya hay una ejecución activa para este Manifest con otro contexto de curso ' +
          `(guardado ${ctx.context_hash.slice(0, 12)}…, enviado ${contextHash.slice(0, 12)}…). ` +
          'El contexto de una ejecución iniciada no cambia; cambiarlo requiere regeneración (Fase 8). ' +
          `runId=${job.id}`,
      );
    }
    const existingVideoMode = this.videoModeOf(job);
    // EV6 T5 B2: tras un upgrade de video, una pestaña vieja que reanuda con el modo ORIGINAL no es un conflicto.
    const upgradedFrom = videoUpgradeOf(job.input_payload) ? job.input_payload?.videoModeOriginal : undefined;
    if (existingVideoMode !== videoMode && upgradedFrom !== videoMode) {
      throw new ConflictException(
        `Ya hay una ejecución activa para este Manifest con otro modo de video (guardado ${existingVideoMode}, ` +
          `enviado ${videoMode}). El modo de video de una ejecución iniciada no cambia. runId=${job.id}`,
      );
    }
    if (providerModes && !sameProviderModes(frozenProviderModesOf(job.input_payload), providerModes)) {
      throw new ConflictException({
        message: `Ya hay una ejecución activa para este Manifest con otros modos de proveedor; no cambian una vez iniciada. runId=${job.id}`,
        code: PROVIDER_MODES_CONFLICT,
      });
    }
    return { created: false, reopened: false, run: await this.buildRunDto(job, manifest) };
  }

  /**
   * EV6 DoD: 'real' si se omite o viene vacío; 'mock' SOLO con el escape de QA (403
   * `video_preview_not_allowed` antes de escribir o estimar nada). Cualquier otro valor ya fue
   * rechazado por el DTO (400).
   */
  private normalizeVideoMode(v: unknown): RunVideoMode {
    if (v === 'mock') {
      assertVideoPreviewAllowed();
      return 'mock';
    }
    return v === 'real' ? 'real' : DEFAULT_VIDEO_MODE;
  }

  /** videoMode congelado de un run ya existente; ausente (runs previos a esta feature) → 'mock'. */
  /** V2.1 RF-b: modos de gasto congelados del run (video + providerModes; sin providerModes ⇒ real, fail safe). */
  private spendModesOf(job: any): RunSpendModes {
    return runSpendModes(this.videoModeOf(job), frozenProviderModesOf(job?.input_payload));
  }

  private videoModeOf(job: any): RunVideoMode {
    const v = job?.input_payload?.videoMode;
    return (RUN_VIDEO_MODES as readonly string[]).includes(v) ? v : LEGACY_VIDEO_MODE;
  }

  /**
   * R10: reabre un run terminado en cancelled/failed (el caller ya verificó
   * que el hash de contexto es el mismo). En una transacción con la fila del
   * job bloqueada FOR UPDATE:
   * - items `cancelled` → `pending`, o `blocked` si alguna de sus
   *   dependencias está failed (o queda blocked) — punto fijo; con lease,
   *   worker, next_retry_at y finished_at en NULL;
   * - items failed/completed/pending/blocked: intactos (failed se reintenta
   *   con retryItem); mismas filas, mismas idempotency keys;
   * - run → status = worker_status = 'queued'.
   * Si mientras tanto el run ya volvió a estar activo (otra reapertura
   * concurrente) → se devuelve como existente. Si otro run del Manifest
   * quedara activo, el índice único parcial da 23505 → se devuelve ese.
   */
  private async reopenRun(jobId: string, manifest: ManifestDto, contextHash: string): Promise<StartRunResult> {
    let outcome: { kind: 'reopened' } | { kind: 'active'; row: any };
    try {
      outcome = await this.tx(async (qr) => {
        // I1: lock del curso primero (antes de cualquier FOR UPDATE).
        await this.lockCourseRuns(qr, manifest.courseId);
        const [locked] = await qr.query(`select * from public.production_jobs where id = $1 for update`, [jobId]);
        if (isActive(locked)) return { kind: 'active' as const, row: locked };
        const other = await this.findActiveRunOnOtherManifest(qr, manifest.courseId, manifest.id);
        if (other) throw this.otherActiveRunConflict(other, manifest);
        const superseding = await this.findSupersedingRun(qr, jobId);
        if (superseding) throw this.supersededConflict(jobId, superseding);
        if (!isReopenable(locked)) {
          throw new ConflictException(
            `La ejecución anterior de este Manifest ya terminó (${locked.worker_status}); re-ejecutar un Manifest ` +
              `completo es regeneración (Fase 8). runId=${jobId}`,
          );
        }

        const items: Array<{ id: string; item_key: string; status: ItemRunStatus; depends_on: string[]; output_summary: Record<string, any> | null }> =
          await qr.query(
            `select id, item_key, status, depends_on, output_summary from public.generation_item_runs g
              where g.job_id = $1 and ${latestGenerationPredicate('g')} order by id for update`,
            [jobId],
          );
        const status = new Map<string, ItemRunStatus>(items.map((i) => [i.item_key, i.status]));
        // EV6 T5 B2 (I-1): las generaciones de un upgrade de video cancelado quedan canceladas (el run
        // puede terminar `failed` solo por ellas → empaquetable con esos videos pendientes, §2.6). Volver
        // a generarlas exige un upgrade NUEVO con vista previa y aprobación: reabrir nunca re-cobra.
        // Las PREGUNTAS (LLM) de un video del upgrade que sí terminó se reabren: describen ese video real.
        const cascadeSourceDone = (i: { output_summary: Record<string, any> | null }) => {
          const src = i.output_summary?.regeneration?.cascadeFromItemKey;
          return i.output_summary?.regeneration?.reason === VIDEO_UPGRADE_CASCADE_REASON && !!src && status.get(src) === 'completed';
        };
        const reopen = items.filter((i) => i.status === 'cancelled' && (!isUpgradeGeneration(i.output_summary) || cascadeSourceDone(i)));
        for (const i of reopen) status.set(i.item_key, 'pending');
        let changed = true;
        while (changed) {
          changed = false;
          for (const i of reopen) {
            if (status.get(i.item_key) !== 'pending') continue;
            const bad = (i.depends_on ?? []).some((d) => !status.has(d) || ['failed', 'blocked'].includes(status.get(d)));
            if (bad) {
              status.set(i.item_key, 'blocked');
              changed = true;
            }
          }
        }
        for (const target of ['pending', 'blocked'] as const) {
          const ids = reopen.filter((i) => status.get(i.item_key) === target).map((i) => i.id);
          if (ids.length === 0) continue;
          const rows = returningRows(
            await qr.query(
              `update public.generation_item_runs
                  set status = $2, lease_until = null, worker_id = null, next_retry_at = null,
                      finished_at = null, updated_at = now()
                where id = any($1::uuid[]) and status = 'cancelled'
                returning id`,
              [ids, target],
            ),
          );
          if (rows.length !== ids.length) {
            throw new InternalServerErrorException(
              `Reapertura inconsistente de la ejecución ${jobId} (${rows.length}/${ids.length} items → ${target})`,
            );
          }
          for (const id of ids) await recordItemReopened(qr, id, { actor: 'owner', strategy: 'reopen_run' });
        }

        await qr.query(
          `update public.production_jobs
              set status = 'queued', worker_status = 'queued', finished_at = null, error_message = null,
                  next_retry_at = null, lease_until = null, worker_id = null,
                  output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('lastReopenedAt', now()),
                  updated_at = now()
            where id = $1`,
          [jobId],
        );
        return { kind: 'reopened' as const };
      });
    } catch (err) {
      if (isActiveRunConflict(err)) {
        const winner = await this.findActiveRunRow(manifest.id);
        if (winner) return this.existingRunOrConflict(winner, manifest, contextHash, this.videoModeOf(winner));
      }
      throw err;
    }
    if (outcome.kind === 'active') {
      return this.existingRunOrConflict(outcome.row, manifest, contextHash, this.videoModeOf(outcome.row));
    }
    return { created: false, reopened: true, run: await this.buildRunDto(await this.loadJobById(jobId), manifest) };
  }

  /** Run más reciente del Manifest (cualquier estado; reconciliado). */
  private async findLatestRunRow(manifestId: number): Promise<any | null> {
    const [row] = await this.dataSource.query(
      `select * from public.production_jobs
        where execution_mode = 'dynamic_generation' and input_payload->>'manifestId' = $1
        order by created_at desc, id desc
        limit 1`,
      [String(manifestId)],
    );
    return row ? this.reconcileCancellation(row) : null;
  }

  private assertRequiredContext(context: Record<string, any>): void {
    const missing = REQUIRED_CONTEXT_FIELDS.filter((k) => !context[k]);
    if (context.prevCourse && !context.prevCourse.nombre) missing.push('prevCourse.nombre' as any);
    if (missing.length > 0) {
      throw new BadRequestException(`Contexto de curso incompleto: ${missing.join(', ')} vacío(s) o solo espacios`);
    }
  }

  /**
   * Transacción con manejo seguro: connect/startTransaction dentro del try;
   * un fallo del rollback se registra pero NUNCA reemplaza al error original
   * (así el 23505 del índice de run activo sigue llegando al caller).
   */
  async tx<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      const out = await fn(qr);
      await qr.commitTransaction();
      // EV6 DoD BE-B: recién DESPUÉS del commit se avisa que un run pasó a `completed` (empaque automático).
      this.fireRunCompleted(takeCompletedRunsInTx(qr));
      return out;
    } catch (err) {
      takeCompletedRunsInTx(qr); // rollback: lo anotado no ocurrió
      if (qr.isTransactionActive) {
        try {
          await qr.rollbackTransaction();
        } catch (rollbackErr) {
          this.logger.warn(
            `rollback falló (se conserva el error original): ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
        }
      }
      throw err;
    } finally {
      try {
        await qr.release();
      } catch {
        /* conexión ya liberada o nunca obtenida */
      }
    }
  }

  /**
   * EV6 DoD BE-B: registra un oyente de «el run pasó a completed» (lo usa AutoPackageService). Se llama
   * después del commit, sin esperar (fire-and-forget con log); un error nunca afecta a la transición.
   */
  onRunCompleted(listener: (runId: string) => unknown): void {
    this.runCompletedListeners.push(listener);
  }

  /** Para tests/harnesses: espera a que terminen los avisos de runs completados en curso. */
  async settleRunCompletedHooks(): Promise<void> {
    while (this.pendingRunCompletedHooks.size) await Promise.allSettled([...this.pendingRunCompletedHooks]);
  }

  private fireRunCompleted(runIds: string[]): void {
    if (!runIds.length || !this.runCompletedListeners.length) return;
    for (const runId of runIds) {
      for (const l of this.runCompletedListeners) {
        const p: Promise<unknown> = Promise.resolve()
          .then(() => l(runId))
          .catch((err) => this.logger.warn(`run ${runId} completado: el aviso posterior falló (${err instanceof Error ? err.message : String(err)})`))
          .finally(() => this.pendingRunCompletedHooks.delete(p));
        this.pendingRunCompletedHooks.add(p);
      }
    }
  }

  /** Run activo del Manifest (después de reconciliar un cancel legacy). */
  private async findActiveRunRow(manifestId: number): Promise<any | null> {
    const rows = await this.dataSource.query(
      `select * from public.production_jobs
        where execution_mode = 'dynamic_generation'
          and input_payload->>'manifestId' = $1
          and worker_status = any($2::text[])
        order by created_at desc`,
      [String(manifestId), ACTIVE_RUN_WORKER_STATUSES],
    );
    for (const row of rows) {
      const r = await this.reconcileCancellation(row);
      if (!isCancelledLike(r)) return r;
    }
    return null;
  }

  private async loadRunRow(courseId: number, manifest: ManifestDto, runId: string): Promise<any> {
    const [row] = await this.dataSource.query(
      `select * from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation'
          and course_id = $2 and input_payload->>'manifestId' = $3`,
      [runId, courseId, String(manifest.id)],
    );
    if (!row) {
      throw new NotFoundException(
        `La ejecución ${runId} no existe para el Manifest del Blueprint v${manifest.blueprintNumber} del curso #${courseId}`,
      );
    }
    return row;
  }

  private async loadJobById(jobId: string): Promise<any> {
    const [row] = await this.dataSource.query(`select * from public.production_jobs where id = $1`, [jobId]);
    if (!row) throw new InternalServerErrorException(`La ejecución ${jobId} desapareció`);
    return row;
  }

  private async loadContextRow(jobId: string): Promise<{ context: Record<string, any>; context_hash: string }> {
    const [row] = await this.dataSource.query(
      `select context, context_hash from public.generation_run_contexts where job_id = $1`,
      [jobId],
    );
    if (!row) {
      throw new InternalServerErrorException(`La ejecución ${jobId} no tiene contexto congelado (integridad rota)`);
    }
    if (canonicalContextHash(row.context) !== row.context_hash) {
      throw new InternalServerErrorException(
        `La ejecución ${jobId}: el contexto guardado no coincide con su context_hash (integridad rota)`,
      );
    }
    return row;
  }

  /**
   * R9: si el job del run quedó cancelled/cancelling por cualquier camino
   * (p.ej. PATCH /jobs/:id legacy), cancela los items no terminales y
   * normaliza el run a status = worker_status = 'cancelled'. Idempotente.
   * Devuelve la fila del job actualizada.
   */
  async reconcileCancellation(job: any): Promise<any> {
    if (!isCancelledLike(job)) return job;
    if (job.status === 'cancelled' && job.worker_status === 'cancelled') {
      const [{ n }] = await this.dataSource.query(
        `select count(*)::int as n from public.generation_item_runs where job_id = $1 and status = any($2::text[])`,
        [job.id, NON_TERMINAL_ITEM_STATUSES],
      );
      if (n === 0) return job;
    }
    await this.tx(async (qr) => {
      await this.markRunCancelled(qr, job.id, null, 'reconciled_from_job_status');
      await this.cancelOpenItems(qr, job.id);
    });
    return this.loadJobById(job.id);
  }

  /**
   * Task 3 (R12 + barrido en lectura): en un run activo, barre los leases
   * vencidos de sus items y recalcula su estado (p.ej. un run reabierto con
   * solo items failed queda `failed`). Runs terminales/cancelados: intactos.
   * Fila del run bloqueada primero (mismo orden de locks que el scheduler).
   */
  private async sweepAndRecompute(job: any): Promise<any> {
    if (!isActive(job)) return job;
    // #583 (N8): cada GET del run (el panel lo sondea, y cada lane del ejecutor también) abría una
    // transacción de escritura con SELECT … FOR UPDATE sobre la fila del run — la misma que bloquean los
    // claims / heartbeats / completes — aunque no hubiera nada que barrer (15 round-trips + BEGIN/COMMIT
    // por GET; staging tiene 2 conexiones para la API). Un chequeo de solo lectura decide si la
    // transacción puede cambiar algo: con un lease vencido, o con el estado del run desalineado de sus
    // items (ninguno activo → terminal; alguno running y el run no `running`), sigue el camino de siempre.
    // Si no, recomputeRunStatus no escribiría nada: se devuelve la fila tal cual, sin locks.
    const [pre] = await this.dataSource.query(
      // Fix round 1 (M4): `expired` sobre TODAS las filas del run (igual que sweepRunExpiredLeases), no solo
      // la generación vigente; active/running sobre la vigente (igual que recomputeRunStatus).
      `select (select count(*)::int from public.generation_item_runs x
                where x.job_id = $1 and x.status = 'running' and x.lease_until < now()) as expired,
              count(*) filter (where g.status in ('pending', 'running', 'retrying'))::int as active,
              count(*) filter (where g.status = 'running')::int as running
         from public.generation_item_runs g
        where g.job_id = $1 and ${latestGenerationPredicate('g')}`,
      [job.id],
    );
    if (pre && Number(pre.expired) === 0 && Number(pre.active) > 0 && (Number(pre.running) === 0 || job.worker_status === 'running')) {
      return job;
    }
    let changed = false;
    await this.tx(async (qr) => {
      const [locked] = await qr.query(`select * from public.production_jobs where id = $1 for update`, [job.id]);
      if (!locked || !isActive(locked)) return;
      const swept = await sweepRunExpiredLeases(qr, job.id);
      const status = await recomputeRunStatus(qr, job.id);
      changed = swept > 0 || status !== locked.worker_status;
    });
    return changed ? this.loadJobById(job.id) : job;
  }

  private async markRunCancelled(qr: QueryRunner, jobId: string, requestedBy: string | null, reason: string) {
    returningRows(
      await qr.query(
        `update public.production_jobs
            set status = 'cancelled',
                worker_status = 'cancelled',
                finished_at = coalesce(finished_at, now()),
                next_retry_at = null,
                output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                  'cancellation', jsonb_build_object('requestedAt', now(), 'requestedBy', $2::text, 'reason', $3::text)
                ),
                updated_at = now()
          where id = $1
            and execution_mode = 'dynamic_generation'
            and (status is distinct from 'cancelled' or worker_status is distinct from 'cancelled')
          returning id`,
        [jobId, requestedBy, reason],
      ),
    );
  }

  private async cancelOpenItems(qr: QueryRunner, jobId: string): Promise<string[]> {
    const rows = returningRows(
      await qr.query(
        `update public.generation_item_runs
            set status = 'cancelled', lease_until = null, next_retry_at = null,
                finished_at = coalesce(finished_at, now()), updated_at = now()
          where job_id = $1 and status = any($2::text[])
          returning id`,
        [jobId, NON_TERMINAL_ITEM_STATUSES],
      ),
    );
    const ids = rows.map((r: any) => r.id);
    // REL R2: los intentos abiertos de los items cancelados quedan `abandoned` (misma transacción).
    await recordItemsAbandoned(qr, ids);
    return ids;
  }

  /**
   * Dependientes transitivos de `itemKey` que pasan de blocked a pending:
   * punto fijo sobre el cierre transitivo — un item se desbloquea cuando
   * TODAS sus dependencias (literales del Manifest) existen y no están en
   * failed/blocked/cancelled. Solo toca el cierre de `itemKey`.
   */
  private dependentsToUnblock(
    items: Array<{ id: string; item_key: string; status: ItemRunStatus; depends_on: string[] }>,
    itemKey: string,
  ): string[] {
    const byKey = new Map(items.map((i) => [i.item_key, i]));
    const status = new Map<string, ItemRunStatus>(items.map((i) => [i.item_key, i.status]));
    status.set(itemKey, 'pending');

    const closure = new Set<string>();
    const queue = [itemKey];
    while (queue.length) {
      const k = queue.shift();
      for (const i of items) {
        if (!closure.has(i.item_key) && (i.depends_on ?? []).includes(k)) {
          closure.add(i.item_key);
          queue.push(i.item_key);
        }
      }
    }

    const out: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const k of closure) {
        if (status.get(k) !== 'blocked') continue;
        const deps = byKey.get(k).depends_on ?? [];
        const ok = deps.every((d) => status.has(d) && !['failed', 'blocked', 'cancelled'].includes(status.get(d)));
        if (ok) {
          status.set(k, 'pending');
          out.push(byKey.get(k).id);
          changed = true;
        }
      }
    }
    return out;
  }

  private async buildRunDto(job: any, manifest: ManifestDto, read?: RunReadOptions): Promise<RunDto> {
    job = await this.reconcileCancellation(job);
    job = await this.sweepAndRecompute(job);
    const ctx = await this.loadContextRow(job.id);
    // F78-BE2: una fila por item — la generación vigente (las anteriores son histórico).
    const rows = await this.dataSource.query(
      `select * from public.generation_item_runs g where g.job_id = $1 and ${latestGenerationPredicate('g')}`,
      [job.id],
    );
    const progress = await this.progress(job.id, manifest);
    if (rows.length !== progress.total) {
      throw new InternalServerErrorException(`La ejecución ${job.id}: ${rows.length} items vs ${progress.total} del Manifest`);
    }

    const order = new Map(manifest.manifest.items.map((it, i) => [it.key, i]));
    rows.sort((a: any, b: any) => (order.get(a.item_key) ?? 1e9) - (order.get(b.item_key) ?? 1e9));
    const strategy = frozenVideoDeliveryOf(job.input_payload);
    const costs = await loadItemCosts(this.dataSource, job.id);
    const itemDtos = rows.map((r: any) => this.toItemDto(r, strategy, costs));
    const completion = await this.completionOf(job, rows, manifest);

    return {
      id: job.id,
      courseId: job.course_id,
      manifestId: manifest.id,
      blueprintId: manifest.blueprintId,
      blueprintNumber: manifest.blueprintNumber,
      rulesVersion: manifest.rulesVersion,
      status: job.status,
      workerStatus: job.worker_status,
      videoMode: this.videoModeOf(job),
      ...(job.input_payload?.videoModeOriginal ? { videoModeOriginal: job.input_payload.videoModeOriginal } : {}),
      videoUpgrade: videoUpgradeOf(job.input_payload),
      upgradedVideoKeys: [...upgradedVideoKeysOf(job.input_payload)].sort(),
      videoDelivery: strategy,
      videoDeliverySummary: this.videoDeliverySummaryOf(itemDtos),
      courseContextSha256: ctx.context_hash,
      courseContext: ctx.context,
      createdAt: toIso(job.created_at),
      updatedAt: toIso(job.updated_at),
      finishedAt: toIso(job.finished_at),
      progress,
      items: itemDtos,
      completion,
      autoRecovery: autoRecoveryEnabled(),
      lastBrowserActivityAt: lastBrowserActivityOf(rows),
      executionLease: executionLeaseView(job, normalizeRequestingExecutorId(read?.executorId), isActive(job)),
    };
  }

  /**
   * EV6 DoD: `RunDto.completion`. El paquete solo se consulta cuando la generación está completa
   * (misma clave de reuse que el empaque: package-freshness.ts); §2.6 solo en runs failed/cancelled
   * con upgrade.
   */
  private async completionOf(job: any, rows: any[], manifest: ManifestDto): Promise<RunCompletion> {
    const m = { rulesVersion: manifest.rulesVersion, items: manifest.manifest.items };
    // Fix round 1 (C1): procedencia de los videos arrastrados por fromRun (preguntas arrastradas con ellos).
    rows = await attachCarryChains(this.dataSource, rows.map((r) => ({ ...r })));
    const upgradeOnlyFailure = !!videoUpgradeOf(job.input_payload) && (job.worker_status === 'failed' || isCancelledLike(job))
      ? await runIsUpgradeOnlyFailure(this.dataSource, job)
      : false;
    // Fix round 2: items completados antes de la validación de servidor de su tipo (cursos viejos) cuentan validados.
    const validationCutoffs = await loadValidationCutoffs(this.dataSource);
    // V542 (G6): reservas de Videogen sin liquidar que ningún worker va a liquidar → reconcile_videogen (SUPER_ADMIN).
    const pendingVideogenReservations = await loadPendingVideogenReservations(this.dataSource, String(job.id));
    const first = evaluateRunCompletion(job, rows, m, null, { upgradeOnlyFailure, validationCutoffs, pendingVideogenReservations });
    if (!first.generationComplete) return first;
    const q = { query: this.dataSource.query.bind(this.dataSource) };
    const ready = await hasDeliverablePackage(q, job, manifest, this.logger);
    // BE-B: `packaging` mientras el paquete final se arma o el servidor lo reintenta solo; fallido sin
    // reintento automático → needs_attention + retry_package.
    const pk = await loadAutoPackageState(q, job, new Date(), process.env, manifest.rulesVersion);
    // Fix round 1 (I1): un job final completado que ya no es el build vigente = `stale`; se re-arma solo si el
    // estado lo declara pendiente (builder nuevo / re-completitud sin confirmar), si no queda una acción visible.
    const stale = !ready && pk.status === 'completed';
    return evaluateRunCompletion(job, rows, m, {
      ready,
      status: stale ? 'stale' : pk.status,
      autoRetryPending: stale ? pk.rebuildPending : pk.autoRetryPending,
      auto: pk.eligible && autoPackageEnabled(),
      blocked: pk.blocked ? { code: pk.blocked.code, message: pk.blocked.message, missing: pk.blocked.missing } : null,
    }, { upgradeOnlyFailure, validationCutoffs, pendingVideogenReservations });
  }

  /**
   * EV6 DoD BE-B: completitud de un run para la cola de recuperación de admin. SOLO LECTURA (a diferencia
   * de buildRunDto no barre leases ni recalcula: el listado nunca escribe). El caller ya resolvió el run
   * y su Manifest congelado (con el dueño real).
   */
  async completionForAdmin(job: any, manifest: ManifestDto): Promise<{ completion: RunCompletion; rows: any[] }> {
    const rows = await this.dataSource.query(
      `select * from public.generation_item_runs g where g.job_id = $1 and ${latestGenerationPredicate('g')}`,
      [job.id],
    );
    return { completion: await this.completionOf(job, rows, manifest), rows };
  }

  /**
   * Progreso agregado con `GROUP BY status, type`. total =
   * manifest.totals.totalJobs, y se exige que coincida con la cantidad real
   * de items del run (si no → 500: integridad rota, nunca un % engañoso).
   */
  private async progress(jobId: string, manifest: ManifestDto): Promise<RunProgress> {
    const rows: Array<{ status: ItemRunStatus; type: ManifestItemType; n: number }> = await this.dataSource.query(
      `select g.status, g.type, count(*)::int as n from public.generation_item_runs g
        where g.job_id = $1 and ${latestGenerationPredicate('g')} group by g.status, g.type`,
      [jobId],
    );
    const all = emptyCounts();
    const byType = Object.fromEntries(
      itemTypesForRulesVersion(manifest.rulesVersion).map((t) => [t, emptyCounts()]),
    ) as Partial<Record<ManifestItemType, StatusCounts>>;
    for (const r of rows) {
      if (!ITEM_STATUSES.includes(r.status) || !byType[r.type]) {
        throw new InternalServerErrorException(`La ejecución ${jobId}: estado/tipo de item desconocido (${r.status}/${r.type})`);
      }
      all[r.status] += r.n;
      all.total += r.n;
      byType[r.type][r.status] += r.n;
      byType[r.type].total += r.n;
    }
    const total = manifest.totals.totalJobs;
    if (all.total !== total) {
      throw new InternalServerErrorException(
        `La ejecución ${jobId}: tiene ${all.total} items pero el Manifest #${manifest.id} declara ${total}`,
      );
    }
    return { ...all, total, pct: total > 0 ? all.completed / total : 0, byType };
  }

  /** DN-1: conteo por estado de entrega de los items video (null si no hay videos). */
  private videoDeliverySummaryOf(items: ItemRunDto[]): RunVideoDeliverySummary | null {
    const videos = items.filter((i) => i.delivery);
    if (videos.length === 0) return null;
    const byState: Record<string, number> = {};
    for (const v of videos) byState[v.delivery!.state] = (byState[v.delivery!.state] ?? 0) + 1;
    const needsAttention = videos.some((v) => (v.delivery!.actions ?? []).length > 0);
    return { total: videos.length, byState, needsAttention };
  }

  private toItemDto(r: any, strategy?: VideoDeliveryStrategy, costs?: Map<string, ItemCostView> | null): ItemRunDto {
    const delivery =
      r.type === 'video' && strategy
        ? deliveryViewOf({ strategy, itemStatus: r.status, error: r.error ?? null, outputSummary: r.output_summary ?? {}, nextRetryAt: r.next_retry_at ?? null })
        : undefined;
    return {
      id: r.id,
      itemKey: r.item_key,
      type: r.type,
      moduleId: r.module_id,
      chapterId: r.chapter_id ?? null,
      dependsOn: r.depends_on ?? [],
      status: r.status,
      generation: r.generation,
      attemptCount: r.attempt_count,
      maxAttempts: r.max_attempts,
      nextRetryAt: toIso(r.next_retry_at),
      error: r.error ?? null,
      idempotencyKey: r.idempotency_key,
      outputSummary: r.output_summary ?? {},
      ...(delivery ? { delivery } : {}),
      recovery: recoveryViewOf(r),
      ...(costs ? { cost: costs.get(r.item_key) ?? { estimated: null, actual: '0', pending: '0', currency: 'USD' as const } } : {}),
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
      finishedAt: toIso(r.finished_at),
    };
  }
}
