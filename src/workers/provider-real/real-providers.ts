// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 F2 — modo REAL del dynamic-provider-worker (review final I1):
//
//  presentation:<ch>  → Gamma (lógica probada de gamma-worker.ts: textOptions
//                       es-419, themeId, poll GET /generations/{id}, PDF,
//                       portada = página 1 con pdftoppm). slideCount medido con
//                       R9 `pdfPageCount`; artifact según el contrato R9.
//  audio_welcome      → OpenAI TTS del texto `welcome` del course_intro (sin LLM).
//  audiobook_chapter  → r19: el capítulo COMPLETO narrado por bloques `##` (un
//                       guion por bloque con el LLM server-side, medido en el
//                       ledger) + OpenAI TTS por segmento con clave determinística.
//                       Guiones y segmentos se persisten apenas se pagan: un
//                       reintento solo genera lo que falta. Manifiesto validado
//                       (frames, Info, segmentos esperados = generados =
//                       concatenados) antes de completar.
//
// Invariantes:
//  - Toda llamada pagada NUEVA pasa antes por el runtime guard de presupuesto
//    (fail-closed; bloqueado → item `blocked` budget_exceeded, 0 llamadas) y
//    registra su evento en el ledger (CALCULATED_FROM_USAGE, idempotente por el
//    id externo).
//  - Falta de configuración (clave, themeId, pdftoppm) → falla FUERTE antes de
//    gastar (`provider_not_ready` / GAMMA_COVER_RASTERIZER_UNAVAILABLE).
//  - Gamma es idempotente: el generationId se persiste en output_summary.external
//    apenas existe; un re-claim NUNCA reenvía (sigue polleando esa generación).
//    Un envío con marcador y sin id (crash a mitad) → `ambiguous_gamma_submission`.
//  - Cada guion de bloque del audiolibro se persiste en output_summary.audiobookSections
//    al validarse y cada segmento de TTS en Storage + output_summary.audioSegments al
//    pagarse: un re-claim no vuelve a pagar nada de lo guardado.
//  - Las claves se leen del entorno en cada item y nunca se loguean.
// ─────────────────────────────────────────────────────────────────────────────
import { markLostResultResendCharge, persistedPaidOpIds, lostResultConsumeMark } from '../../modules/dynamic-generation/lost-result';
import { createHash } from 'crypto';
import type { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { ArtifactsService } from '../../modules/artifacts/artifacts.service';
import type { ClaimedItem, SchedulerService } from '../../modules/dynamic-generation/scheduler.service';
import { PROVIDER_NOT_READY, missingGammaThemes } from '../../modules/dynamic-generation/provider-readiness';
import { loadPackagingProfilesV3 } from '../../modules/dynamic-packaging/packaging-v3';
import {
  PRESENTATION_ARTIFACT_SCHEMA_VERSION,
  PresentationArtifact,
  gammaThemeFor,
  pdfPageCount,
  pngDimensions,
  validatePresentationArtifact,
} from '../../package/presentation';
import {
  AUDIOBOOK_MANIFEST_VERSION,
  AUDIOBOOK_MAX_RATIO,
  AUDIOBOOK_TARGET_BITRATE_KBPS,
  AUDIOBOOK_WPM_REF,
  AUDIOBOOK_WPM_MAX,
  AUDIOBOOK_WPM_MIN,
  AUDIOBOOK_WPM_MIN_WORDS,
  AudiobookChapterManifest,
  AudiobookManifestSegment,
  audioFramesOf,
  concatMp3,
  mp3DurationSeconds,
  parseMp3,
  validateChapterAudioManifest,
} from '../../package/audio';
import { transcodeMp3Bitrate } from '../../tts/mp3-transcode.util';
import { TTS_SNAPSHOT_MODEL, resolveTtsModel } from '../../tts/tts-models';
import type { ThemeFamilyId, ThemeMode } from '../../modules/theme-engine/types';
import {
  GuardNextCall,
  LedgerWriteFailed,
  TTS_CHARS_PER_SECOND_ESTIMATE,
  PROVIDER_RESERVATION_MARGIN,
  WorkerBudget,
  WorkerLedger,
  budgetExceededMessage,
  gammaChargeInput,
  gammaPendingInput,
  priorPaidOperations,
  providerCallRoleOf,
  reconciliationMessage,
  recordGammaPending,
  reservePaidCall,
  serverLlmChargeInput,
  settleGammaCharge,
  settlePaidCall,
  ttsChargeInput,
  RunBudgetCapReached,
  pauseRunForCap,
  reservePaidCalls,
} from '../finops-worker-hooks';
import { AnthropicClient, GammaClient, OpenAiTtsClient, ProviderCallError } from './provider-clients';
import { CoverError, CoverRasterizer, GAMMA_COVER_RASTERIZER_UNAVAILABLE, pdftoppmRasterizer } from './pdf-cover';
import { DRAIN_HANDBACK_RETRY_SECONDS, DrainSignal, drainHandbackMessage, runPausedHandbackMessage } from '../worker-drain';
import {
  adoptLateExternalId, fencedScheduler, IN_FLIGHT_WINDOW_MS, inFlightRemainingMs, priorAttemptMayBeInFlight, priorCallInFlightMessage,
  PROCESS_ITEM_FENCE, providerOfReservationKey, retryAfterSecondsFor,
} from '../lease-takeover';
import { ITEM_RECOVERY_BUDGET_REASON, RUN_PAUSED_GUARD_REASON } from '../../modules/finops/finops-budget.service';
import { itemRecoveryBudgetMessage } from '../../modules/finops/run-spend-guard';
import {
  AUDIOBOOK_SCRIPT_MODEL_DEFAULT,
  AUDIOBOOK_SCRIPT_MODEL_ENV,
  AudioScriptError,
  AudiobookSectionPlan,
  ChapterScriptInput,
  ScriptLlm,
  TTS_MAX_CHARS,
  audiobookSegments,
  blocksToDropForRepetition,
  chapterTargetSeconds,
  cleanAudioText,
  findScriptRepetition,
  generateSectionExtension,
  generateSectionScript,
  planChapterExtension,
  planAudiobookSections,
  splitForTts,
  welcomeScriptFromCourseIntro,
  wordCount,
} from './audio-scripts';
import { llmCallUpperBoundUsage } from '../../modules/finops/llm-usage-ingest';

type Env = Record<string, string | undefined>;

export const GAMMA_NUM_CARDS = 10;
// r59: se fija el snapshot. El alias `gpt-4o-mini-tts` se colgaba de forma intermitente (staging 2026-10-19:
// 5 de 11 llamadas >60 s, terminaban a los 125–172 s y se cobraban); el snapshot fijo, 0 de 13. Mismo precio
// que el alias (filas propias en pricing-seed.v1). OPENAI_TTS_MODEL sigue teniendo prioridad.
export const TTS_MODEL_DEFAULT = TTS_SNAPSHOT_MODEL; // r60: una sola constante (src/tts/tts-models.ts)
export const TTS_VOICE_DEFAULT = 'marin';
export const TTS_TARGET_BITRATE_KBPS = 64;
/** Envío a Gamma de resultado desconocido (5xx/red/timeout/sin id tras enviar): nunca se reenvía solo. */
export const AMBIGUOUS_GAMMA_SUBMISSION = 'gamma_submit_ambiguous';

/**
 * F2 fix round 1: ¿el error de un envío es un rechazo DEFINITIVO anterior a la
 * aceptación? Solo un 4xx con respuesta lo es (el proveedor no procesó el
 * pedido). 5xx, red, timeout o una respuesta sin id → resultado desconocido
 * (pudo cobrarse).
 */
export function isDefinitiveRejection(err: unknown): boolean {
  // Review (minor): 408 (timeout del lado del proveedor) y 409 (conflicto: p.ej. ya existe) NO prueban
  // que el pedido no se procesó → ambiguos, nunca "sin gasto".
  return err instanceof ProviderCallError && err.status !== null && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 409;
}

/**
 * r62 (K2, regla de ambigüedad acotada punto 4; review N1 C1): solo un RECHAZO DE ADMISIÓN del proveedor es un resultado
 * CONOCIDO sin cobro: 429 (rate limit), 503 (servicio no disponible) y 529 (sobrecarga). La reserva se libera y el intento
 * se reintenta con backoff (clase A). 500/502/504/524 —un gateway que corta mientras el upstream sigue trabajando, como
 * los cuelgues de 125–172 s que OpenAI terminó y COBRÓ (phase-b-n1-tts-root-cause.md)— y 408/409 son AMBIGUOS: la
 * reserva queda y van por la reconciliación con el reenvío único acotado de K1 (possible_duplicate).
 */
export const TTS_KNOWN_NOT_CHARGED_STATUSES: readonly number[] = Object.freeze([429, 503, 529]);
export function isKnownTransientHttpError(err: unknown): boolean {
  return err instanceof ProviderCallError && err.status !== null && TTS_KNOWN_NOT_CHARGED_STATUSES.includes(err.status);
}

export interface RealProviderDeps {
  scheduler: Pick<SchedulerService, 'completeItem' | 'failItem'> &
    Partial<Pick<SchedulerService, 'blockItemForBudget' | 'recordItemExternal' | 'heartbeatItem'>>;
  dataSource: Pick<DataSource, 'query'>;
  artifacts: Pick<ArtifactsService, 'uploadJsonArtifact'> &
    Partial<Pick<ArtifactsService, 'uploadBufferArtifact' | 'putStorageObject' | 'getDownloadUrl' | 'downloadStorageObject'>>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  executorId: string;
  leaseSeconds: number;
  finops?: WorkerLedger | null;
  budget: WorkerBudget;
  /** Entorno (claves, URLs base, themeIds). Default: process.env al momento del item. */
  env?: Env;
  /** Portada: default `pdftoppm` (como el legacy). Inyectable en tests. */
  rasterizer?: CoverRasterizer;
  /** Poll de Gamma (ms). Default env DYNAMIC_GAMMA_POLL_MS o 6000. */
  gammaPollMs?: number;
  /** Tope de espera de UNA generación en este claim (ms). Default env DYNAMIC_GAMMA_TIMEOUT_MS o 5 min. */
  gammaTimeoutMs?: number;
  /** Estado de la llamada pagada en curso (lo crea processRealProviderItem por item). */
  tracker?: PaidCallTracker;
  /** R16 (#1): señal de drenado del proceso (SIGINT/SIGTERM). */
  drain?: DrainSignal | null;
}

/**
 * V2.1 calibración #2: qué gasto está "en el aire" en este claim.
 * - inFlight: se reservó y se envió al proveedor, sin liquidación todavía;
 * - unpersistedPaidOutput: el proveedor ya entregó (y se cobró) un resultado que aún no quedó persistido.
 * Con cualquiera de los dos, NINGÚN fallo es reintentable automáticamente: reconciliación.
 */
export interface PaidCallTracker {
  inFlight: { provider: string; key: string; opId?: string | null } | null;
  unpersistedPaidOutput: { provider: string; what: string; opIds: string[] } | null;
}

export function newPaidCallTracker(): PaidCallTracker {
  return { inFlight: null, unpersistedPaidOutput: null };
}

function trackerAmbiguity(t: PaidCallTracker | undefined): { provider: string; what: string; opIds: string[] } | null {
  if (!t) return null;
  if (t.inFlight) {
    return { provider: t.inFlight.provider, what: 'llamada pagada enviada sin resultado liquidado', opIds: t.inFlight.opId ? [t.inFlight.opId] : [] };
  }
  return t.unpersistedPaidOutput;
}

/** Fallo del item (el caller ya lo registró con failItem). `retryable=false` → se relanza (fail loud). */
export class ProviderItemFailed extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'ProviderItemFailed';
  }
}

class LeaseLost extends Error {}
/** El guard bloqueó una llamada intermedia (el item ya quedó `blocked`). */
class BudgetBlocked extends Error {}

function envOf(deps: RealProviderDeps): Env {
  return deps.env ?? process.env;
}

function trimmed(env: Env, k: string): string {
  return (env[k] ?? '').trim();
}

function requireFinops(deps: RealProviderDeps): WorkerLedger {
  if (!deps.finops) throw new LedgerWriteFailed('el cargo del proveedor', 'ledger FinOps no configurado en el worker');
  return deps.finops;
}

function positiveInt(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function sha256(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fail(
  deps: RealProviderDeps,
  item: ClaimedItem,
  message: string,
  retryable: boolean,
  opts: { knownOutcome?: boolean; grantAttempt?: boolean } = {},
): Promise<never> {
  // Review I4: resultado CONOCIDO del proveedor (guion rechazado por validación, audio no medible):
  // no es ambiguo → reintento acotado normal. El intento queda reconocido de forma durable ANTES de
  // fallar (si esa escritura falla, se lanza y termina en reconciliación, nunca en un pago ciego).
  if (opts.knownOutcome && retryable && !deps.tracker?.inFlight) {
    await record(deps, item, { reconciliationAcknowledgedThroughAttempt: item.attempt, knownPaidFailure: message.slice(0, 300) });
    if (deps.tracker) deps.tracker.unpersistedPaidOutput = null;
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, message.slice(0, 1900), true);
    throw new ProviderItemFailed(message, true);
  }
  // Con gasto "en el aire" (enviado sin liquidar, o resultado pagado sin persistir) un reintento
  // automático volvería a pagar: el fallo pasa a reconciliación, nunca reintentable.
  const amb = trackerAmbiguity(deps.tracker);
  if (amb && retryable) {
    message = reconciliationMessage(amb.provider, amb.what, `${message}${amb.opIds.length ? ` (operación del proveedor: ${amb.opIds.join(', ')})` : ''}`);
    retryable = false;
  }
  if (retryable && opts.grantAttempt) {
    // R16 (#16): espera gratuita (re-poll de un id persistido): no consume max_attempts.
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, message.slice(0, 1900), true, undefined, { grantAttempt: true });
  } else {
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, message.slice(0, 1900), retryable);
  }
  throw new ProviderItemFailed(message, retryable);
}

/**
 * R16 (#16): tope de reloj (desde el primer poll de la generación) durante el cual un
 * `gamma_timeout` NO consume intentos — pollear un generationId persistido es gratis.
 * Pasado el tope, cada timeout vuelve a consumir un intento (y el auto-healer acota las rondas).
 */
export const GAMMA_TIMEOUT_FREE_WALL_MS = 60 * 60_000;

/**
 * R16 (#1): el proceso está drenando y NO hay gasto en el aire (nada enviado sin
 * liquidar, ningún resultado pagado sin persistir) → el item se devuelve
 * (retrying, intento concedido) y responde true. Con gasto en el aire nunca
 * devuelve: el item sigue hasta persistir lo pagado.
 */
async function handBackIfDraining(deps: RealProviderDeps, item: ClaimedItem, where: string): Promise<boolean> {
  if (!deps.drain?.isDraining) return false;
  if (deps.tracker?.inFlight || deps.tracker?.unpersistedPaidOutput) return false;
  const ok = await deps.scheduler.failItem(item.itemRunId, deps.executorId, drainHandbackMessage(where), true, undefined, {
    retryAfterSeconds: DRAIN_HANDBACK_RETRY_SECONDS,
    grantAttempt: true,
  });
  deps.logger.warn(`Item ${item.itemKey}: drenado — devuelto ${where}${ok ? '' : ' (el item ya no era de este worker)'}`);
  return true;
}

/**
 * r61 (Q-21): una llamada pagada de un intento ANTERIOR figura enviada (`sentAt`) y sin liquidar y todavía puede estar
 * en vuelo (lease tomada) → el item vuelve a la cola con retryAfter ≥ lo que falta de la ventana, sin consumir intento
 * y sin llamar. true = devuelto. Pasada la ventana responde false (sigue el camino de reconciliación de siempre).
 */
async function handBackIfPriorInFlight(deps: RealProviderDeps, item: ClaimedItem, what: string, sentAt: string | Date | null | undefined, windowMs: number): Promise<boolean> {
  return handBackPriorInFlight(deps, item, what, inFlightRemainingMs(sentAt ?? null, windowMs));
}

async function handBackPriorInFlight(deps: RealProviderDeps, item: ClaimedItem, what: string, left: number): Promise<boolean> {
  if (!(left > 0) || !priorAttemptMayBeInFlight(item)) return false;
  const ok = await deps.scheduler.failItem(item.itemRunId, deps.executorId, priorCallInFlightMessage(what, left), true, undefined, {
    retryAfterSeconds: retryAfterSecondsFor(left),
    grantAttempt: true,
  });
  deps.logger.warn(`Item ${item.itemKey}: ${what} del intento anterior puede seguir en vuelo (~${Math.ceil(left / 1000)} s) — devuelto sin llamar${ok ? '' : ' (el item ya no era de este worker)'}`);
  return true;
}

/** Runtime guard antes de una llamada pagada NUEVA. false = item bloqueado (sin llamada). */
async function guard(deps: RealProviderDeps, item: ClaimedItem, provider?: string, nextCall?: GuardNextCall): Promise<boolean> {
  const g = await deps.budget.guardPaidSubmission({
    runId: item.runId, itemRunId: item.itemRunId, itemType: item.type, ...(provider ? { provider } : {}), ...(nextCall ? { nextCall } : {}),
  });
  if (g.allow) return true;
  if ((g.reason === RUN_PAUSED_GUARD_REASON || g.reason === ITEM_RECOVERY_BUDGET_REASON) && (deps.tracker?.inFlight || deps.tracker?.unpersistedPaidOutput)) {
    // Review I1: hay salida PAGADA sin persistir (p. ej. el bloque principal de una sección del audiolibro y falta
    // su continuación): devolver ahora la dejaría huérfana → reconciliación al reanudar y se volvería a pagar.
    // Igual que el drenaje: la unidad en curso termina y se persiste; la pausa se aplica en el próximo borde limpio.
    return true;
  }
  if (g.reason === ITEM_RECOVERY_BUDGET_REASON) {
    // Loop Cost Efficiency: ESTA parte agotó su presupuesto de recuperación → se detiene solo ella (no reintentable,
    // fuera del auto-heal); el resto del curso sigue.
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, itemRecoveryBudgetMessage((g as { detail?: string }).detail || 'presupuesto de recuperación agotado'), false);
    deps.logger.warn(`Item ${item.itemKey}: presupuesto de recuperación agotado — no se llama al proveedor`);
    return false;
  }
  if (g.reason === RUN_PAUSED_GUARD_REASON) {
    // Piloto #1209: el run se pausó con la parte ya reclamada → vuelve a la cola sin llamar (sin gasto, sin
    // consumir intento); el claim no la entrega mientras el run siga pausado.
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, runPausedHandbackMessage(provider ?? item.type), true, undefined, {
      retryAfterSeconds: DRAIN_HANDBACK_RETRY_SECONDS, grantAttempt: true,
    });
    deps.logger.warn(`Item ${item.itemKey}: run pausado — devuelto sin llamar al proveedor`);
    return false;
  }
  if (!deps.scheduler.blockItemForBudget) throw new Error('dynamic-provider-worker: scheduler sin blockItemForBudget');
  deps.logger.warn(`Item ${item.itemKey}: presupuesto excedido (${g.reason}) — no se llama al proveedor${provider ? ` (${provider})` : ''}`);
  await deps.scheduler.blockItemForBudget(item.itemRunId, deps.executorId, budgetExceededMessage(g));
  return false;
}

async function record(deps: RealProviderDeps, item: ClaimedItem, patch: Record<string, any>): Promise<void> {
  if (!deps.scheduler.recordItemExternal) throw new Error('dynamic-provider-worker: scheduler sin recordItemExternal (modo real)');
  const ok = await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, patch);
  if (!ok) throw new LeaseLost();
}

/**
 * Review r2 (N1): marcador DURABLE de envío de una llamada pagada de una unidad pre-reservada (chunk de TTS, llamada
 * del guion): se escribe en el item justo ANTES de llamar. Al re-reclamar, una reserva de unidad SIN marcador nunca
 * salió → se libera (sin conciliación humana); con marcador sigue el camino de siempre.
 */
const PAID_CALLS_SENT_KEY = 'paidCallsSent';
const sentByItem = new Map<string, Record<string, string>>();
async function markPaidCallSent(deps: RealProviderDeps, item: ClaimedItem, resKey: string): Promise<void> {
  const os = (item.outputSummary ?? {}) as Record<string, any>;
  const cur = sentByItem.get(item.itemRunId) ?? { ...((os[PAID_CALLS_SENT_KEY] && typeof os[PAID_CALLS_SENT_KEY] === 'object') ? os[PAID_CALLS_SENT_KEY] : {}) };
  cur[resKey] = new Date().toISOString();
  sentByItem.set(item.itemRunId, cur);
  await record(deps, item, { [PAID_CALLS_SENT_KEY]: cur });
}
/** ¿Reserva de una unidad pre-reservada (chunk de TTS de bienvenida o llamada del guion por bloque)? */
function isUnitReservationKey(key: string): boolean {
  return /^reservation:tts:.*:chunk\d+$/.test(key) || /^reservation:llm:.*:sec\d+-(main|continuation|condense)$/.test(key);
}

async function heartbeat(deps: RealProviderDeps, item: ClaimedItem): Promise<void> {
  if (!deps.scheduler.heartbeatItem) return;
  const ok = await deps.scheduler.heartbeatItem(item.itemRunId, deps.executorId, deps.leaseSeconds);
  if (!ok) throw new LeaseLost();
}

function notReady(item: ClaimedItem, what: string[]): string {
  return (
    `${PROVIDER_NOT_READY}: el item ${item.itemKey} (${item.type}) necesita ${what.join(', ')} en el entorno del worker; ` +
    'no se llamó al proveedor (sin gasto). Configura lo que falta y reintenta esta parte.'
  );
}

/** Texto de un artifact de dependencia (URL firmada del Storage; nunca con la clave del proveedor). */
async function dependencyText(deps: RealProviderDeps, item: ClaimedItem, ownerId: string, type: string): Promise<string> {
  const dep = (item.dependencyArtifacts ?? []).find((a) => a.type === type);
  if (!dep) await fail(deps, item, `missing_dependency_artifact: ${item.itemKey} no tiene su artifact ${type}`, false);
  if (!deps.artifacts.getDownloadUrl) throw new Error('dynamic-provider-worker: artifacts sin getDownloadUrl (modo real)');
  try {
    const d = await deps.artifacts.getDownloadUrl(dep!.artifactId, ownerId, 3600);
    if (!d.url) throw new Error(`sin URL de descarga para el artifact ${dep!.artifactId}`);
    const res = await fetch(d.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error('vacío');
    return text;
  } catch (err) {
    return fail(deps, item, `dependency_download_failed: ${type} de ${item.itemKey} (${err instanceof Error ? err.message : String(err)})`, true);
  }
}

/** Markdown del content (acepta `{markdown}` JSON o texto plano, como el worker de video). */
function markdownOf(text: string): string {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.markdown === 'string') return j.markdown;
  } catch {
    /* texto plano */
  }
  return text;
}

function storageBase(item: ClaimedItem, ownerId: string, artifactType: string): string {
  return `${ownerId}/dynamic/${item.artifactCourseId}/${item.manifestId}/${artifactType}/${item.idempotencyKey}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// presentation:<ch> — Gamma
// ═══════════════════════════════════════════════════════════════════════════

/** Tope de additionalInstructions de la API de Gamma (caracteres). */
export const GAMMA_ADDITIONAL_INSTRUCTIONS_MAX = 2000;

/**
 * Motor pedagógico Fase 2: línea «Enfoque didáctico…» del brief del item (solo si el claim la trae y
 * es del generador `presentation`). Va DESPUÉS de las reglas de siempre (veracidad, idioma, portada),
 * que mandan; si no cabe en el tope de Gamma se omite (la regla técnica gana) y no se trunca a medias.
 */
export function gammaPedagogyInstructions(item: Pick<ClaimedItem, 'pedagogy'>): string | null {
  const p = item.pedagogy;
  return p && p.generator === 'presentation' && typeof p.text === 'string' && p.text.trim() ? p.text.trim() : null;
}

/** Cuerpo de la generación: el del legacy probado (gamma-worker.ts), sin las marcas PARTE A/B del layout V1. */
export function gammaGenerationBody(input: { chapterTitle: string; chapterDescription?: string | null; contentMarkdown: string; themeId: string; pedagogyInstructions?: string | null }): Record<string, unknown> {
  // Title Normalization: el título (breve) encabeza la portada; la descripción es contexto, nunca título.
  const desc = input.chapterDescription && input.chapterDescription.trim() ? `${input.chapterDescription.trim()}\n\n` : '';
  const body = gammaGenerationBodyBase(input, desc);
  const ped = input.pedagogyInstructions && input.pedagogyInstructions.trim() ? input.pedagogyInstructions.trim() : '';
  if (ped) {
    const withPed = `${body.additionalInstructions} ${ped}`;
    if (withPed.length <= GAMMA_ADDITIONAL_INSTRUCTIONS_MAX) body.additionalInstructions = withPed;
  }
  return body;
}

function gammaGenerationBodyBase(input: { chapterTitle: string; contentMarkdown: string; themeId: string }, desc: string): Record<string, unknown> & { additionalInstructions: string } {
  return {
    inputText: `${input.chapterTitle}\n\n${desc}${cleanAudioText(input.contentMarkdown)}`,
    textMode: 'generate',
    format: 'presentation',
    numCards: GAMMA_NUM_CARDS,
    additionalInstructions:
      'La diapositiva 1 es la portada del capítulo y debe mostrar su título. ' +
      'El resto desarrolla el contenido en bloques temáticos coherentes, en español latinoamericano NEUTRO con tuteo (tú): nunca voseo, «vosotros» ni regionalismos de ningún país. ' +
      // R14: con textMode 'generate' Gamma completa el texto; no debe inventar cifras ni fuentes.
      'No agregues cifras, porcentajes, estadísticas, estudios, encuestas, instituciones ni citas que no estén literalmente en el texto; si el texto no trae un dato, no lo inventes. ' +
      // R14-12: Gamma rotuló casos ilustrativos como "Caso real"/"Ejemplo real" y convirtió una mención de
      // Hattie en una cita atribuida ("… — John Hattie").
      'Los casos, personajes y ejemplos del texto son ilustrativos: nunca los rotules como «caso real», «ejemplo real» o «historia real» ni les agregues resultados que el texto no afirma. ' +
      'No pongas frases entre comillas atribuidas a autores o personas reales. ' +
      // R14-13: afirmaciones caducas y leyes de otro país (LOPD es España; en Colombia, Ley 1581 de 2012).
      'No afirmes capacidades ni limitaciones permanentes de las herramientas de IA (acceso a internet, memoria): depende de la herramienta. ' +
      'Nombra las leyes como en el texto y nunca con siglas de leyes de otros países (p. ej., LOPD).',
    cardOptions: {
      dimensions: '16x9',
      headerFooter: { bottomRight: { type: 'image', source: 'themeLogo', size: 'sm' } },
    },
    // es-419 explícito: sin esto Gamma puede responder en inglés (CLAUDE.md, historial #5).
    textOptions: { amount: 'brief', language: 'es-419' },
    imageOptions: {
      source: 'aiGenerated',
      style:
        'Fotografía realista o ilustración editorial que funcione como apoyo visual ' +
        'educativo del contenido de la diapositiva — personas, escenas, objetos y entornos ' +
        'reales del sector y contexto del curso. Sin ningún texto, letra, palabra, número, ' +
        'letrero, cartel, señalización, logo, marca de agua ni tipografía dentro de la ' +
        'imagen: ningún elemento gráfico debe intentar representar texto legible.',
    },
    sharingOptions: { externalAccess: 'view' },
    themeId: input.themeId,
    exportAs: 'pdf',
  };
}

async function currentThemeOf(deps: RealProviderDeps, courseId: number): Promise<{ familyId: ThemeFamilyId; mode: ThemeMode }> {
  // Misma resolución que el empaque (perfil vigente → paleta legacy → default v3).
  const profiles = await loadPackagingProfilesV3(deps.dataSource as any, courseId, true);
  return { familyId: profiles.theme.input.themeFamily as ThemeFamilyId, mode: profiles.theme.input.mode as ThemeMode };
}

export async function processRealPresentation(deps: RealProviderDeps, item: ClaimedItem, ownerId: string): Promise<void> {
  const env = envOf(deps);
  const external = (item.outputSummary?.external ?? {}) as Record<string, any>;
  const apiKey = trimmed(env, 'GAMMA_API_KEY');
  let generationId: string | null = typeof external.gammaGenerationId === 'string' ? external.gammaGenerationId : null;
  let themeFamily: ThemeFamilyId;
  let themeMode: ThemeMode;
  let themeId: string;
  const rasterizer = deps.rasterizer ?? pdftoppmRasterizer(env);

  if (generationId) {
    // Reanudación: la generación ya existe (y ya se pagó) — NUNCA se reenvía.
    if (!apiKey) await fail(deps, item, notReady(item, ['GAMMA_API_KEY']), false);
    // Con reserva previa al envío (calibración #2), ESA reserva cuenta el gasto hasta el terminal.
    // Items anteriores (sin reserva): cargo pendiente por generationId, estricto (error → reintento sin reenviar).
    const gid0 = generationId;
    if (!(typeof item.outputSummary?.externalReservationKey === 'string')) {
      await recordGammaPending(requireFinops(deps), { ownerId, itemRunId: item.itemRunId, generationId: gid0, itemAttempt: external.acceptedAtAttempt ?? item.attempt });
    }
    themeFamily = external.themeFamily;
    themeMode = external.themeMode;
    themeId = external.gammaThemeId;
  } else if (item.outputSummary?.externalSubmitStartedAt) {
    // r61 (Q-21): el envío del intento anterior todavía puede estar en vuelo (lease tomada) → no se decide aún:
    // la parte vuelve a la cola; si el worker anterior recibe el generationId lo registra (adoptLateExternalId).
    if (await handBackIfPriorInFlight(deps, item, 'el envío a Gamma', String(item.outputSummary.externalSubmitStartedAt), IN_FLIGHT_WINDOW_MS.gamma)) return;
    await gammaAmbiguous(
      deps, item, ownerId, String(item.outputSummary.externalSubmitStartedAt),
      `un envío empezó (${item.outputSummary.externalSubmitStartedAt}) y no registró el generationId (crash o lease perdida a mitad)`,
    );
    return;
  } else {
    // R16 (#1): drenando → no se empieza un envío pagado nuevo a Gamma.
    if (await handBackIfDraining(deps, item, 'antes de enviar a Gamma (sin gasto)')) return;
    // Envío NUEVO: guard de presupuesto → configuración → marcador → envío.
    if (!(await guard(deps, item))) return;
    if (!apiKey) await fail(deps, item, notReady(item, ['GAMMA_API_KEY']), false);
    const missing: string[] = [];
    let theme: { familyId: ThemeFamilyId; mode: ThemeMode };
    try {
      theme = await currentThemeOf(deps, item.courseId);
    } catch (err) {
      return fail(deps, item, `theme_resolution_failed: ${err instanceof Error ? err.message : String(err)} (no se llamó a Gamma)`, false);
    }
    themeFamily = theme.familyId;
    themeMode = theme.mode;
    try {
      themeId = gammaThemeFor(themeFamily, themeMode);
    } catch {
      missing.push(...missingGammaThemes(env).filter((m) => m.includes(themeFamily.toUpperCase().replace(/-/g, '_'))));
      if (!missing.some((m) => m.startsWith('GAMMA_THEME'))) missing.push(`GAMMA_THEME_V21_*_${themeMode.toUpperCase()}`);
    }
    if (missing.length) await fail(deps, item, notReady(item, missing), false);
    if (!(await rasterizer.available())) {
      await fail(
        deps,
        item,
        `${GAMMA_COVER_RASTERIZER_UNAVAILABLE}: el worker no tiene pdftoppm (poppler-utils) para la portada obligatoria y la API de ` +
          'Gamma no entrega una miniatura; no se envió nada a Gamma (sin gasto).',
        false,
      );
    }
    const markdown = markdownOf(await dependencyText(deps, item, ownerId, 'dynamic_content_md'));
    const chapterTitle = item.blueprint?.chapter?.title ?? `Capítulo ${item.chapterNumber ?? '?'}`;
    const client = new GammaClient(apiKey, env);
    // Calibración #2: reserva DURABLE → marcador (con la clave de la reserva) → envío.
    // Si la reserva o el marcador fallan, se lanza ANTES de llamar a Gamma (0 llamadas).
    const resKey = await reservePaidCall(deps.finops, {
      kind: 'gamma', ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt, tag: 'submit', estimate: {},
    });
    // Motor pedagógico Fase 2: el enfoque de las diapositivas (si el claim lo trae) al final de additionalInstructions.
    const pedLine = gammaPedagogyInstructions(item);
    const gammaBody = gammaGenerationBody({
      chapterTitle, chapterDescription: item.blueprint?.chapter?.description ?? null, contentMarkdown: markdown, themeId: themeId!,
      pedagogyInstructions: pedLine,
    });
    const pedApplied = !!pedLine && String(gammaBody.additionalInstructions).endsWith(pedLine);
    if (pedLine && !pedApplied) {
      deps.logger.warn(`Item ${item.itemKey}: el enfoque didáctico no cabe en additionalInstructions de Gamma (tope ${GAMMA_ADDITIONAL_INSTRUCTIONS_MAX}); se envía sin él (manda el límite técnico)`);
    }
    const marker = new Date().toISOString();
    await record(deps, item, {
      externalSubmitStartedAt: marker, externalReservationKey: resKey,
      // Qué diseño recibió Gamma (auditoría simétrica con el navegador).
      ...(item.pedagogy ? { pedagogySha256: item.pedagogy.textSha256, pedagogyApplied: pedApplied } : {}),
    });
    const tracker = deps.tracker;
    if (tracker) {
      tracker.inFlight = { provider: 'gamma', key: resKey };
      (tracker as any).gammaReservationKey = resKey;
    }
    try {
      generationId = await client.createGeneration(gammaBody);
    } catch (err) {
      // SOLO un 4xx con respuesta es un rechazo definitivo previo a la aceptación → se libera la
      // reserva, se limpia el marcador y el reintento automático (acotado) puede reenviar.
      if (isDefinitiveRejection(err)) {
        const e = err as ProviderCallError;
        await settlePaidCall(deps.finops, resKey, null, 'gamma_rejected_definitively');
        if (tracker) tracker.inFlight = null;
        await record(deps, item, { externalSubmitStartedAt: null, externalReservationKey: null });
        await fail(deps, item, `gamma_submit_failed: ${e.message}`, e.retryable);
      }
      // 5xx / red / timeout / respuesta sin id: Gamma pudo aceptarla (y cobrarla) → la reserva queda
      // pendiente + item detenido para una decisión humana explícita (nunca un reenvío automático).
      await gammaAmbiguous(deps, item, ownerId, marker, err instanceof Error ? err.message : String(err));
      return;
    }
    if (tracker && tracker.inFlight) tracker.inFlight.opId = generationId;
    deps.logger.log(`Item ${item.itemKey}: Gamma aceptó la generación ${generationId}`);
    const gammaExternal = { gammaGenerationId: generationId, gammaThemeId: themeId!, themeFamily, themeMode, acceptedAtAttempt: item.attempt };
    try {
      await record(deps, item, { external: gammaExternal });
    } catch (err) {
      if (!(err instanceof LeaseLost)) throw err;
      // r61 (Q-21): la lease se tomó con el envío en vuelo. La generación YA existe (y se cobra): se registra su id
      // cercado por el marcador de ESTE envío, así el próximo reclamante la retoma por poll (gratis) y liquida esta
      // reserva en el terminal, en vez de quedar ambigua o de reenviarla.
      const adopted = await adoptLateExternalId(deps.dataSource as any, item.itemRunId, marker, 'gammaGenerationId', gammaExternal).catch(() => false);
      deps.logger.warn(`Item ${item.itemKey}: lease perdida tras el envío a Gamma (${generationId}) — id ${adopted ? 'registrado tarde para el próximo reclamante' : 'NO registrado (el marcador cambió)'}`);
      if (adopted && tracker) tracker.inFlight = null;
      throw err;
    }
    // Id persistido: la generación es reanudable (poll gratis) → ya no es un gasto "en el aire".
    // La reserva sigue contando el gasto (p90) hasta el terminal, donde se liquida con los créditos medidos.
    if (tracker) tracker.inFlight = null;
  }

  // ── poll hasta completed/failed ────────────────────────────────────────────
  const client = new GammaClient(apiKey, env);
  const pollMs = deps.gammaPollMs ?? positiveInt(env.DYNAMIC_GAMMA_POLL_MS, 6000);
  const timeoutMs = deps.gammaTimeoutMs ?? positiveInt(env.DYNAMIC_GAMMA_TIMEOUT_MS, 5 * 60_000);
  const t0 = Date.now();
  // R16 (#16): inicio (durable) de la espera de ESTA generación, para el tope de reloj de los timeouts gratuitos.
  const pollSinceRaw = item.outputSummary?.gammaPollSince;
  const pollSince = typeof pollSinceRaw === 'string' && Number.isFinite(Date.parse(pollSinceRaw)) ? Date.parse(pollSinceRaw) : t0;
  if (typeof pollSinceRaw !== 'string') await record(deps, item, { gammaPollSince: new Date(t0).toISOString() });
  let st = await pollOnce(deps, item, client, generationId!);
  while (st.status !== 'completed' && st.status !== 'failed') {
    // R16 (#1): la generación ya está persistida → otro worker la re-pollea gratis.
    if (await handBackIfDraining(deps, item, `mientras esperaba la generación ${generationId} de Gamma (se retoma sin reenviar)`)) return;
    if (Date.now() - t0 > timeoutMs) {
      // Reintentable: el próximo claim sigue polleando la MISMA generación. Dentro del tope de reloj no consume intentos.
      await fail(deps, item, `gamma_timeout: la generación ${generationId} no terminó en ${Math.round(timeoutMs / 1000)} s (se retoma sin reenviar)`, true, {
        grantAttempt: Date.now() - pollSince < GAMMA_TIMEOUT_FREE_WALL_MS,
      });
    }
    await heartbeat(deps, item);
    await sleep(pollMs);
    st = await pollOnce(deps, item, client, generationId!);
  }
  const gid = generationId!;
  // Terminal: la reserva pendiente se liquida con los créditos medidos (ADJUSTMENT); sin créditos queda pendiente.
  // Nunca se ignora un error del ledger: lanza → reintento que retoma la MISMA generación (sin reenviar).
  const acceptedAttempt = external.acceptedAtAttempt ?? item.attempt;
  const measuredCredits = typeof st.creditsDeducted === 'number' && Number.isFinite(st.creditsDeducted) && st.creditsDeducted >= 0;
  const resKeyT = typeof item.outputSummary?.externalReservationKey === 'string' ? item.outputSummary.externalReservationKey : (deps.tracker as any)?.gammaReservationKey ?? null;
  if (resKeyT) {
    // Calibración #2: reserva → UN cargo por generationId (medido; sin créditos → pendiente estimado), atómico.
    const finalInput = measuredCredits
      ? gammaChargeInput({ ownerId, itemRunId: item.itemRunId, generationId: gid, creditsDeducted: st.creditsDeducted, creditsRemaining: st.creditsRemaining, failed: st.status === 'failed', itemAttempt: acceptedAttempt })
      : gammaPendingInput({ ownerId, itemRunId: item.itemRunId, generationId: gid, itemAttempt: acceptedAttempt, reason: 'gamma_credits_not_reported' });
    await settlePaidCall(deps.finops, resKeyT, finalInput, measuredCredits ? 'gamma_credits_measured' : 'gamma_credits_not_reported');
    if (!measuredCredits) deps.logger.error(`finops: Gamma no informó credits.deducted de ${gid} — el cargo queda PENDIENTE con el estimado`);
  } else {
    let settled: Awaited<ReturnType<typeof settleGammaCharge>>;
    try {
      settled = await settleGammaCharge(requireFinops(deps), {
        ownerId, itemRunId: item.itemRunId, generationId: gid, creditsDeducted: st.creditsDeducted,
        creditsRemaining: st.creditsRemaining, failed: st.status === 'failed', itemAttempt: acceptedAttempt,
      });
    } catch (err) {
      throw err instanceof LedgerWriteFailed ? err : new LedgerWriteFailed(`la liquidación de Gamma ${gid}`, err);
    }
    if (settled === 'still_pending') deps.logger.error(`finops: Gamma no informó credits.deducted de ${gid} — el cargo queda PENDIENTE con el estimado`);
  }
  if (st.status === 'failed') {
    await fail(
      deps,
      item,
      // REL I5: el clasificador distingue la falla con créditos medidos (B) de la de cobro incierto (C).
      `gamma_generation_failed: la generación ${gid} falló en Gamma (${st.error ?? 'sin detalle'})` +
        (measuredCredits ? ` [créditos medidos: ${st.creditsDeducted}]` : ' [Gamma no informó los créditos: cobro incierto]') +
        '. No se reenvía sola: ' +
        'regenera la presentación para pedir una nueva.',
      false,
    );
  }

  // ── PDF + portada medidos ──────────────────────────────────────────────────
  if (!st.exportUrl) await fail(deps, item, `gamma_export_missing: la generación ${gid} terminó sin exportUrl del PDF`, true);
  let pdf: Buffer;
  try {
    pdf = await client.download(st.exportUrl!);
  } catch (err) {
    return fail(deps, item, `gamma_pdf_download_failed: ${err instanceof Error ? err.message : String(err)} (se reintenta sin reenviar)`, true);
  }
  let slideCount: number;
  try {
    slideCount = pdfPageCount(pdf);
  } catch (err) {
    return fail(deps, item, `gamma_pdf_invalid: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  let cover: Buffer;
  let dims: { width: number; height: number };
  try {
    cover = await rasterizer.firstPagePng(pdf);
    dims = pngDimensions(cover);
  } catch (err) {
    const code = err instanceof CoverError ? err.code : 'GAMMA_COVER_RENDER_FAILED';
    return fail(deps, item, `${code}: ${err instanceof Error ? err.message : String(err)}`, code !== GAMMA_COVER_RASTERIZER_UNAVAILABLE);
  }
  if (!deps.artifacts.putStorageObject) throw new Error('dynamic-provider-worker: artifacts sin putStorageObject (modo real)');
  const baseDir = storageBase(item, ownerId, 'dynamic_presentation');
  const pdfPath = `${baseDir}/a${item.attempt}.pdf`;
  const coverPath = `${baseDir}/a${item.attempt}.cover.png`;
  await deps.artifacts.putStorageObject({ storagePath: pdfPath, buffer: pdf, mimeType: 'application/pdf', upsert: false, adoptExistingOnConflict: true });
  await deps.artifacts.putStorageObject({ storagePath: coverPath, buffer: cover, mimeType: 'image/png', upsert: false, adoptExistingOnConflict: true });

  const artifact: PresentationArtifact = {
    schemaVersion: PRESENTATION_ARTIFACT_SCHEMA_VERSION as 1,
    chapterId: item.chapterId as string,
    gammaGenerationId: gid,
    pdf: { storagePath: pdfPath, sha256: sha256(pdf), bytes: pdf.length },
    cover: { storagePath: coverPath, sha256: sha256(cover), bytes: cover.length, width: dims.width, height: dims.height },
    slideCount,
    themeFamilyAtGeneration: themeFamily!,
    themeModeAtGeneration: themeMode!,
    gammaThemeId: themeId!,
    generatedAt: new Date().toISOString(),
  };
  const errs = validatePresentationArtifact(artifact);
  if (errs.length) await fail(deps, item, `presentation_artifact_invalid: ${errs.map((e) => e.code).join(', ')}`, false);
  const row = await deps.artifacts.uploadJsonArtifact({
    ownerId,
    courseId: item.artifactCourseId,
    jobId: item.runId,
    type: 'dynamic_presentation',
    filename: `${item.chapterId}.presentation.json`,
    storagePath: `${baseDir}/a${item.attempt}.json`,
    payload: artifact,
    mimeType: 'application/json',
    metadata: {
      manifestId: item.manifestId, itemKey: item.itemKey, chapterId: item.chapterId, mode: 'real', provider: 'gamma',
      gammaGenerationId: gid, slideCount, themeFamily: themeFamily!, themeMode: themeMode!,
    },
    upsert: false,
  });
  const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
    artifactIds: [row.id],
    summary: {
      mode: 'real', provider: 'gamma', gammaGenerationId: gid, slideCount, gammaThemeId: themeId!,
      themeFamily: themeFamily!, themeMode: themeMode!, creditsDeducted: st.creditsDeducted,
    },
  });
  if (!ok) deps.logger.warn(`Item ${item.itemKey}: presentación subida (artifact ${row.id}) pero completeItem devolvió false (lease perdida)`);
}

/**
 * Envío ambiguo a Gamma: reserva pendiente (clave sintética por item + marcador,
 * idempotente) y el item queda `failed` NO reintentable con
 * `gamma_submit_ambiguous`. Resolución explícita: revisar la cuenta de Gamma y
 * pedir un reenvío con `POST …/items/:itemKey/retry {"resubmitProvider": true}`.
 */
async function gammaAmbiguous(deps: RealProviderDeps, item: ClaimedItem, ownerId: string, marker: string, why: string): Promise<never> {
  // Con reserva previa al envío (clave en el marcador), ESA fila pendiente ya cuenta el posible gasto.
  // Items anteriores a este cambio (marcador sin reserva) → reserva sintética, estricta.
  if (!deps.finops) {
    deps.logger.error(`finops: worker real sin ledger — la posible generación ambigua de ${item.itemKey} NO quedó reservada`);
  } else if (!(typeof item.outputSummary?.externalReservationKey === 'string') && !deps.tracker?.inFlight) {
    const ms = Date.parse(marker);
    const syntheticId = `ambiguous-${item.itemRunId}-${Number.isFinite(ms) ? ms : 'x'}`;
    await recordGammaPending(requireFinops(deps), { ownerId, itemRunId: item.itemRunId, generationId: syntheticId, itemAttempt: item.attempt, ambiguous: true, reason: why });
  }
  return fail(
    deps,
    item,
    `${AMBIGUOUS_GAMMA_SUBMISSION}: el envío a Gamma quedó sin confirmar (${why.slice(0, 300)}). Puede existir ya una generación ` +
      'cobrada (quedó reservada en el ledger): no se reenvía automáticamente. Revisa la cuenta de Gamma y, si corresponde, ' +
      'pide un reenvío explícito (retry con resubmitProvider=true).',
    false,
  );
}

async function pollOnce(deps: RealProviderDeps, item: ClaimedItem, client: GammaClient, generationId: string) {
  try {
    return await client.getGeneration(generationId);
  } catch (err) {
    const e = err instanceof ProviderCallError ? err : null;
    // Un error del poll nunca reenvía: reintentable (el próximo claim sigue polleando).
    return fail(deps, item, `gamma_poll_failed: ${err instanceof Error ? err.message : String(err)}`, e ? e.retryable || e.status === 404 : true);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// audio_welcome / audiobook_chapter — OpenAI TTS (+ guion LLM del capítulo)
// ═══════════════════════════════════════════════════════════════════════════

export async function processRealAudio(deps: RealProviderDeps, item: ClaimedItem, ownerId: string): Promise<void> {
  if (item.type === 'audiobook_chapter') return processRealAudiobook(deps, item, ownerId);
  // audio_welcome: texto `welcome` del course_intro (sin LLM) → OpenAI TTS. Sin cambios en r19 (64 kbps).
  const env = envOf(deps);
  const openaiKey = trimmed(env, 'OPENAI_API_KEY');

  // Guard (TTS) → configuración COMPLETA antes de la primera llamada pagada.
  if (!(await guard(deps, item))) return;
  if (!openaiKey) await fail(deps, item, notReady(item, ['OPENAI_API_KEY']), false);

  let script: string;
  const text = await dependencyText(deps, item, ownerId, 'dynamic_course_intro_json');
  try {
    script = welcomeScriptFromCourseIntro(JSON.parse(text));
  } catch (err) {
    return fail(deps, item, err instanceof AudioScriptError ? err.message : `AUDIO_WELCOME_TEXT_MISSING: course_intro no es JSON (${err instanceof Error ? err.message : String(err)})`, false);
  }

  const chunks = splitForTts(script);
  if (!chunks.length) await fail(deps, item, `AUDIO_SCRIPT_EMPTY: ${item.itemKey} no tiene texto para narrar`, false);
  // r60 (review I-2): misma regla que las rutas legacy — OPENAI_TTS_MODEL pisa el snapshot, salvo el alias exacto
  // `gpt-4o-mini-tts` (se cuelga), que vuelve al snapshot salvo OPENAI_TTS_ALLOW_ALIAS=true. Reserva y ledger usan este modelo.
  const ttsResolved = resolveTtsModel(undefined, env);
  const model = ttsResolved.model;
  if (ttsResolved.normalized) deps.logger.log(`[provider-real] ${item.itemKey}: OPENAI_TTS_MODEL=${ttsResolved.requested} → ${model} (alias inestable)`);
  const voice = trimmed(env, 'OPENAI_TTS_VOICE') || TTS_VOICE_DEFAULT;
  const tts = new OpenAiTtsClient(openaiKey, env);
  const parts: Buffer[] = [];
  const requestIds: Array<string | null> = [];
  const ttsTracker = deps.tracker;
  const paidTtsOps: string[] = [];
  // FinOps atómico (review I4): el audio es UNA unidad — se reservan TODOS sus chunks antes del primero (todos o
  // ninguno contra el tope del run); así nunca queda a medias por el tope. Los nunca llamados se liberan al salir.
  const unitRes = chunks.map((c, idx) => ({
    kind: 'tts' as const, ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt,
    tag: `chunk${idx}`, estimate: { characters: c.length, model },
  }));
  const unitKeys: string[] = [];
  const calledChunks = new Set<number>();
  let unitDone = false;
  const deferredSettles: Array<{ key: string; charge: ReturnType<typeof ttsChargeInput> }> = [];
  const settleDeferred = async () => {
    while (deferredSettles.length) {
      const d = deferredSettles[0];
      await settlePaidCall(deps.finops, d.key, d.charge, 'openai_tts_measured');
      deferredSettles.shift();
      await consumeLostResultMark(deps, item, d.charge);
    }
  };
  // Defensa (review I1): un fallo de resultado CONOCIDO (que reconoce el intento) exige lo cobrado ya liquidado.
  const failKnown = async (message: string): Promise<never> => {
    if (deferredSettles.length) throw new Error(`invariante r62: ${deferredSettles.length} trozo(s) cobrado(s) sin liquidar antes de reconocer el intento`);
    return fail(deps, item, message, true, { knownOutcome: true });
  };
  try {
  for (let i = 0; i < chunks.length; i++) {
    // R16 (#1): solo ANTES del primer chunk (nada pagado sin persistir). A mitad del audio
    // se termina: devolverlo dejaría chunks pagados sin persistir (reconciliación).
    if (i === 0 && (await handBackIfDraining(deps, item, 'antes de sintetizar el audio (sin gasto)'))) return;
    await heartbeat(deps, item);
    if (i === 0) unitKeys.push(...(await reservePaidCalls(deps.finops, unitRes)));
    const chunkIdx = i;
    // Calibración #2: reserva DURABLE del chunk antes de llamar (si falla, no se llama a OpenAI).
    const resKey = await reservePaidCall(deps.finops, {
      kind: 'tts', ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt,
      tag: `chunk${chunkIdx}`, estimate: { characters: chunks[chunkIdx].length, model },
    });
    if (ttsTracker) ttsTracker.inFlight = { provider: 'openai', key: resKey };
    // Review r2 (N1): marcador de ENVÍO antes de llamar — una reserva de la unidad sin marcador nunca salió y se libera
    // sola al re-reclamar (caída dura del worker); con marcador, la de siempre (conciliación si no hay resultado).
    await markPaidCallSent(deps, item, resKey);
    calledChunks.add(chunkIdx);
    let res;
    try {
      res = await tts.speech({ model, voice, input: chunks[i] });
    } catch (err) {
      const e = err instanceof ProviderCallError ? err : null;
      // Rechazo definitivo (4xx con respuesta) → sin gasto: se libera la reserva. Timeout/red/5xx
      // DESPUÉS de enviar = gasto posible → la reserva queda y el item va a reconciliación (fail()).
      if (isDefinitiveRejection(err)) {
        await settlePaidCall(deps.finops, resKey, null, 'openai_tts_rejected_definitively');
        if (ttsTracker) ttsTracker.inFlight = null;
      }
      if (isKnownTransientHttpError(err)) {
        // r62 (K2): respuesta de error del proveedor = sin cobro → se libera la reserva; los trozos anteriores de este
        // intento quedaron cobrados y MEDIDOS (resultado conocido): el intento se reconoce y se reintenta (clase A).
        await settlePaidCall(deps.finops, resKey, null, 'openai_tts_http_error_not_charged');
        if (ttsTracker) ttsTracker.inFlight = null;
        // r62 (review lost_result I1): los trozos YA cobrados de este intento se liquidan ANTES de reconocer el intento
        // (fail knownOutcome escribe el ack): nunca una reserva cobrada detrás del ack. Si la liquidación falla, se lanza
        // (sin ack) y el intento queda en reconciliación con sus reservas visibles para el reenvío acotado.
        await settleDeferred();
        return await failKnown(`tts_failed: chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return await fail(deps, item, `tts_failed: chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : String(err)}`, e ? e.retryable : true);
    }
    if (ttsTracker && ttsTracker.inFlight) ttsTracker.inFlight.opId = res.requestId;
    let seconds: number | null = null;
    try {
      seconds = mp3DurationSeconds(res.audio);
    } catch {
      seconds = null;
    }
    // Cargo por x-request-id (idempotente: la misma operación = un solo cargo) + reserva a 0, atómico.
    // r62 (E2E M, «resultado pagado perdido» — minimizarlo): la liquidación se DIFIERE hasta que el MP3 quede subido
    // (Storage + artifact). Un kill antes de subir deja las reservas pendientes y marcadas (ambiguo acotado de K1); uno
    // después de subir lo completa priorPaidBlock reutilizando el artifact y liquidando lo pendiente. Toda salida que no
    // sea un kill (falla conocida, error) liquida igual lo diferido (finally): el cargo nunca se pierde.
    deferredSettles.push({ key: resKey, charge: markLostResultResendCharge(ttsChargeInput({
      ownerId, itemRunId: item.itemRunId, requestId: res.requestId, audioSeconds: seconds, characters: chunks[chunkIdx].length,
      model, generation: item.generation ?? 1, chunk: chunkIdx, itemAttempt: item.attempt,
    }), item.outputSummary, item.attempt) });
    if (res.requestId) paidTtsOps.push(res.requestId);
    if (ttsTracker) {
      ttsTracker.inFlight = null;
      ttsTracker.unpersistedPaidOutput = { provider: 'openai', what: 'audio TTS pagado sin persistir', opIds: [...paidTtsOps] };
    }
    if (seconds === null) { await settleDeferred(); await failKnown(`TTS_AUDIO_INVALID: el chunk ${i + 1}/${chunks.length} de ${item.itemKey} no es un MP3 medible`); }
    requestIds.push(res.requestId);
    // Mismo transcode que tts.service (64 kbps mono; sin ffmpeg → el original, como hoy).
    parts.push(await transcodeMp3Bitrate(res.audio, TTS_TARGET_BITRATE_KBPS));
  }
  unitDone = true;
  } finally {
    // r62: una salida del bucle que no es un kill liquida lo ya cobrado (resultado conocido, aunque se pierda).
    if (!unitDone) await settleDeferred().catch((e) => deps.logger.warn(`Item ${item.itemKey}: no se pudo liquidar un chunk cobrado (${e instanceof Error ? e.message : String(e)}); queda la reserva (se concilia al re-reclamar)`));
    // Reservas de chunks que NUNCA se enviaron (la unidad terminó antes): se liberan (sin gasto). Un chunk enviado
    // con resultado incierto conserva su reserva (conciliación), como siempre.
    if (!unitDone) {
      for (let idx = 0; idx < unitKeys.length; idx++) {
        if (!calledChunks.has(idx)) {
          await settlePaidCall(deps.finops, unitKeys[idx], null, 'tts_unit_aborted_before_call').catch((e) =>
            deps.logger.warn(`Item ${item.itemKey}: no se pudo liberar la reserva no enviada ${unitKeys[idx]} (${e instanceof Error ? e.message : String(e)}); se libera al re-reclamar`));
        }
      }
    }
  }
  let mp3: Buffer;
  let durationSeconds: number;
  try {
    // UX r18 fix 1 (C1): SIEMPRE por concatMp3, también con una sola parte: el MP3 final de v3 (bienvenida y
    // capítulos del audiolibro) lleva el frame Info con el conteo real de frames, escrito en JS. El transcode
    // genérico (tts.service / audio-worker legacy / POST /tts/speech) NO escribe Info: esos caminos concatenan
    // bytes crudos y un Info por segmento describiría solo el primero.
    mp3 = concatMp3(parts);
    durationSeconds = mp3DurationSeconds(mp3);
  } catch (err) {
    await settleDeferred();
    return failKnown(`TTS_AUDIO_INVALID: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!deps.artifacts.uploadBufferArtifact) { await settleDeferred(); throw new Error('dynamic-provider-worker: artifacts sin uploadBufferArtifact (modo real)'); }
  const entity = item.chapterId ?? 'course';
  let row: Awaited<ReturnType<NonNullable<typeof deps.artifacts.uploadBufferArtifact>>>;
  try {
  row = await deps.artifacts.uploadBufferArtifact({
    ownerId,
    courseId: item.artifactCourseId,
    jobId: item.runId,
    type: 'dynamic_audio_mp3',
    filename: `${entity}.${item.type}.mp3`,
    storagePath: `${storageBase(item, ownerId, 'dynamic_audio_mp3')}/a${item.attempt}.mp3`,
    buffer: mp3,
    mimeType: 'audio/mpeg',
    metadata: {
      manifestId: item.manifestId, itemKey: item.itemKey, chapterId: item.chapterId, mode: 'real', provider: 'openai',
      model, voice, durationSeconds, chunks: chunks.length, requestIds, scriptSha256: sha256(script),
    },
    upsert: false,
  });
  if (ttsTracker) ttsTracker.unpersistedPaidOutput = null; // el audio pagado ya está en el Storage + artifact
  } finally {
    // Subido o no (error de Storage): lo cobrado queda registrado. Subido → ya no hay resultado pagado sin persistir: si
    // la liquidación falla, el re-claim reutiliza el artifact y liquida lo pendiente (nunca reconciliación ni repago).
    await settleDeferred();
  }
  const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
    artifactIds: [row.id],
    summary: { mode: 'real', provider: 'openai', model, voice, durationSeconds, chunks: chunks.length, scriptSha256: sha256(script) },
  });
  if (!ok) deps.logger.warn(`Item ${item.itemKey}: audio subido (artifact ${row.id}) pero completeItem devolvió false (lease perdida)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// audiobook_chapter — r19: capítulo COMPLETO, bloques y segmentos persistidos
// ═══════════════════════════════════════════════════════════════════════════

/** Bucket de Storage de los artifacts (mismo default que ArtifactsService). */
const ARTIFACTS_BUCKET = 'cursia-artifacts';

/** Plan del capítulo tal como queda en output_summary.audiobookPlan (sin el texto: va en audiobookSections). */
export interface PersistedAudiobookPlan {
  v: 1;
  sha256: string;
  sourceWords: number;
  narratableWords: number;
  excluded: AudiobookSectionPlan['excluded'];
  sections: Array<{ idx: number; title: string; words: number; sha256: string }>;
  /** Fix round 1 (I3): palabras del Markdown crudo y las que no quedaron en ningún bloque ni excluido. */
  rawWords?: number;
  lostWords?: number;
}

/** Guion aceptado de un bloque (output_summary.audiobookSections[idx]). */
export interface PersistedSectionScript {
  sourceSha: string;
  sourceWords: number;
  text: string;
  words: number;
  ratio: number;
  continued: boolean;
  /** r19 (#642): condensado con una llamada acotada (ausente en guiones anteriores). */
  condensed?: boolean;
  messageIds: string[];
  model: string;
}

/** Segmento pagado y guardado (output_summary.audioSegments[segKey]). */
export interface PersistedSegment {
  sectionIdx: number;
  partIdx: number;
  textSha: string;
  audioSha: string;
  frames: number;
  seconds: number;
  bitrateKbps: number | null;
  requestId: string | null;
  storagePath: string;
  bytes: number;
  words: number;
  chars: number;
  /** r62: reserva del segmento y su medición (para liquidarla al reanudar si el worker murió entre guardar y liquidar). */
  reservationKey?: string;
  rawSeconds?: number | null;
  model?: string;
  segIndex?: number;
  attempt?: number;
}

function validPlan(p: unknown): p is PersistedAudiobookPlan {
  const x = p as PersistedAudiobookPlan;
  return !!x && x.v === 1 && typeof x.sha256 === 'string' && Array.isArray(x.sections) && x.sections.length > 0;
}

/** Frames de audio (sin el Info/Xing), duración por frames, bitrate y conteo declarado por el Info. */
export function mp3FrameInfo(buf: Buffer): { frames: number; seconds: number; bitrateKbps: number | null; infoFrames: number | null; samples: number; sampleRate: number } {
  const parsed = parseMp3(buf);
  const audio = audioFramesOf(parsed);
  if (!audio.length) throw new Error('el MP3 solo tiene el frame Xing/Info, sin audio');
  const br = audio[0].bitrateKbps;
  return {
    frames: audio.length,
    seconds: (audio.length * audio[0].samples) / audio[0].sampleRate,
    bitrateKbps: audio.every((f) => f.bitrateKbps === br) ? br : null,
    infoFrames: parsed.hasXing && typeof parsed.xingFrames === 'number' ? parsed.xingFrames : null,
    samples: audio[0].samples,
    sampleRate: audio[0].sampleRate,
  };
}

function wpmOf(words: number, seconds: number): number {
  return seconds > 0 ? Math.round((words / (seconds / 60)) * 10) / 10 : 0;
}

/** Operaciones pagadas cuyo resultado YA está guardado en el item (msg_… de bloques, x-request-id de segmentos) o se descartó a sabiendas. */
export function persistedAudiobookOps(os: Record<string, any> | null | undefined): Set<string> {
  return persistedPaidOpIds(os);
}

/** Ampliación aceptada de un bloque (fix round 1, I1): output_summary.audiobookExtensions[idx][n]. */
export interface PersistedExtension {
  sourceSha: string;
  text: string;
  words: number;
  messageIds: string[];
}

/** Costo estimado de UNA llamada (fix round 1, I5): el guard reserva esto, no el p90 del item entero. */
function ttsCallEstimate(model: string, characters: number): GuardNextCall {
  return { provider: 'openai', service: 'audio.speech', product: model, usage: { audio_seconds: Math.max(1, Math.ceil((characters / TTS_CHARS_PER_SECOND_ESTIMATE) * PROVIDER_RESERVATION_MARGIN)) } };
}
function llmCallEstimate(model: string, promptChars: number, maxTokens: number): GuardNextCall {
  return { provider: 'anthropic', service: 'messages', product: model, usage: llmCallUpperBoundUsage(promptChars, maxTokens) };
}
/** Cota de una llamada del guion antes de conocer el prompt (sistema + bloque de ~900 palabras + cola; salida máxima). */
const LLM_CALL_PROMPT_CHARS_BOUND = 9000;
const LLM_CALL_MAX_TOKENS_BOUND = 3000;

export async function processRealAudiobook(deps: RealProviderDeps, item: ClaimedItem, ownerId: string): Promise<void> {
  const env = envOf(deps);
  const openaiKey = trimmed(env, 'OPENAI_API_KEY');
  const anthropicKey = trimmed(env, 'ANTHROPIC_API_KEY');
  const os = (item.outputSummary ?? {}) as Record<string, any>;
  let plan: PersistedAudiobookPlan | null = validPlan(os.audiobookPlan) ? os.audiobookPlan : null;
  const sections: Record<string, PersistedSectionScript> = { ...((os.audiobookSections ?? {}) as Record<string, PersistedSectionScript>) };
  const extensions: Record<string, PersistedExtension[]> = { ...((os.audiobookExtensions ?? {}) as Record<string, PersistedExtension[]>) };
  const segState: Record<string, PersistedSegment> = { ...((os.audioSegments ?? {}) as Record<string, PersistedSegment>) };
  const discarded: string[] = Array.isArray(os.audiobookDiscardedOps) ? [...os.audiobookDiscardedOps] : [];
  const sectionDone = (p: PersistedAudiobookPlan, i: number) => sections[String(p.sections[i].idx)]?.sourceSha === p.sections[i].sha256;
  const scriptsDone = () => !!plan && plan.sections.every((_, i) => sectionDone(plan as PersistedAudiobookPlan, i));
  const needsLlm = !scriptsDone();
  const tracker = deps.tracker;
  // r60 (review I-2): misma regla que las rutas legacy — OPENAI_TTS_MODEL pisa el snapshot, salvo el alias exacto
  // `gpt-4o-mini-tts` (se cuelga), que vuelve al snapshot salvo OPENAI_TTS_ALLOW_ALIAS=true. Reserva y ledger usan este modelo.
  const ttsResolved = resolveTtsModel(undefined, env);
  const model = ttsResolved.model;
  if (ttsResolved.normalized) deps.logger.log(`[provider-real] ${item.itemKey}: OPENAI_TTS_MODEL=${ttsResolved.requested} → ${model} (alias inestable)`);
  const voice = trimmed(env, 'OPENAI_TTS_VOICE') || TTS_VOICE_DEFAULT;
  const scriptModel = trimmed(env, AUDIOBOOK_SCRIPT_MODEL_ENV) || AUDIOBOOK_SCRIPT_MODEL_DEFAULT;

  // Guard (TTS, una llamada) → configuración COMPLETA antes de la primera llamada pagada.
  if (!(await guard(deps, item, undefined, ttsCallEstimate(model, TTS_MAX_CHARS)))) return;
  const missing: string[] = [];
  if (!openaiKey) missing.push('OPENAI_API_KEY');
  if (needsLlm && !anthropicKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) await fail(deps, item, notReady(item, missing), false);

  // El Markdown del capítulo (descarga gratis): plan de bloques, fuente de la repetición y de las ampliaciones.
  if (needsLlm && (await handBackIfDraining(deps, item, 'antes de pedir el guion del audiolibro (sin gasto)'))) return;
  const markdown = markdownOf(await dependencyText(deps, item, ownerId, 'dynamic_content_md'));
  let full: AudiobookSectionPlan;
  try {
    full = planAudiobookSections(markdown);
  } catch (err) {
    return fail(deps, item, err instanceof AudioScriptError ? err.message : `AUDIOBOOK_PLAN_COVERAGE: ${err instanceof Error ? err.message : String(err)}`, false);
  }
  if (!full.sections.length) {
    await fail(deps, item, `AUDIOBOOK_CONTENT_EMPTY: el capítulo ${item.chapterNumber ?? '?'} no tiene contenido para narrar`, false);
  }
  const srcBySha = new Map(full.sections.map((x) => [x.sha256, x]));
  const input: ChapterScriptInput = {
    courseTitle: item.blueprint?.course?.title ?? 'este curso',
    chapterNumber: item.chapterNumber ?? 0,
    chapterTitle: item.blueprint?.chapter?.title ?? `Capítulo ${item.chapterNumber ?? '?'}`,
    chapterDescription: item.blueprint?.chapter?.description ?? null,
    sector: (item.context?.courseContext as any)?.sector ?? null,
    nivel: (item.context?.courseContext as any)?.nivel ?? null,
    pais: (item.context?.courseContext as any)?.pais ?? null,
    contentMarkdown: markdown,
  };
  const itemRole = providerCallRoleOf(item.attempt);
  let llmClient: AnthropicClient | null = null;
  /** Llamada pagada del guion (bloque o ampliación): guard por llamada → reserva → llamada → liquidación. */
  // FinOps atómico (review I4): el guion de un bloque es UNA unidad (principal + continuación + condensación). Antes
  // de la llamada principal se reservan las tres (todas o ninguna contra el tope): una continuación nunca se queda
  // sin presupuesto con el principal ya pagado. Cota de continuación/condensación: su prompt incluye la salida del
  // principal (≤ 4 caracteres × max_tokens) → prompt principal + 4·max_tokens, y max_tokens ≥ el de la principal.
  const unitState = new Map<string, { keys: Map<string, string>; called: Set<string> }>();
  const releaseUnitUnused = async (tag: string): Promise<void> => {
    const st = unitState.get(tag);
    if (!st) return;
    for (const [role, key] of st.keys) {
      if (!st.called.has(role)) {
        await settlePaidCall(deps.finops, key, null, 'script_unit_unused').catch((e) =>
          deps.logger.warn(`Item ${item.itemKey}: no se pudo liberar la reserva no enviada ${key} (${e instanceof Error ? e.message : String(e)}); se libera al re-reclamar`));
      }
    }
    unitState.delete(tag);
  };
  const llmFor = (tag: string, what: string, paidIds: string[]): ScriptLlm => async (prompt, role) => {
    await heartbeat(deps, item);
    if (!(await guard(deps, item, 'anthropic', llmCallEstimate(scriptModel, prompt.system.length + prompt.user.length, prompt.maxTokens)))) throw new BudgetBlocked();
    if (role === 'main' && !unitState.has(tag)) {
      const mainChars = prompt.system.length + prompt.user.length;
      // Review r2 (N4): la condensación tras una continuación incluye ambas salidas → cota con las dos.
      const followChars = mainChars + 5 * (prompt.maxTokens + LLM_CALL_MAX_TOKENS_BOUND);
      const followTokens = Math.max(prompt.maxTokens, LLM_CALL_MAX_TOKENS_BOUND);
      const roles = ['main', 'continuation', 'condense'] as const;
      const rs = roles.map((r) => ({
        kind: 'llm' as const, ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt, tag: `${tag}-${r}`,
        estimate: r === 'main' ? { promptChars: mainChars, maxTokens: prompt.maxTokens, model: scriptModel } : { promptChars: followChars, maxTokens: followTokens, model: scriptModel },
      }));
      const keys = await reservePaidCalls(deps.finops, rs);
      unitState.set(tag, { keys: new Map(roles.map((r, i) => [r, keys[i]])), called: new Set() });
    }
    // Calibración #2: reserva DURABLE antes de la llamada (si falla, no se llama). Dentro de una unidad ya reservada
    // devuelve la reserva existente (idempotente, sin volver a contarla).
    const resKey = await reservePaidCall(deps.finops, {
      kind: 'llm', ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt,
      tag: `${tag}-${role}`,
      estimate: { promptChars: prompt.system.length + prompt.user.length, maxTokens: prompt.maxTokens, model: scriptModel },
    });
    if (tracker) tracker.inFlight = { provider: 'anthropic', key: resKey };
    // Review r2 (N1/N2): enviada = marcada justo antes de la llamada (nunca antes de la reserva).
    await markPaidCallSent(deps, item, resKey);
    unitState.get(tag)?.called.add(role);
    if (!llmClient) llmClient = new AnthropicClient(anthropicKey, env);
    let r;
    try {
      r = await llmClient.messages({ model: scriptModel, system: prompt.system, user: prompt.user, maxTokens: prompt.maxTokens });
    } catch (err) {
      // Rechazo definitivo (4xx con respuesta) → sin gasto: se libera la reserva. Cualquier otro
      // resultado (timeout/red/5xx/sin id-usage) queda reservado y el item va a reconciliación.
      if (isDefinitiveRejection(err)) {
        await settlePaidCall(deps.finops, resKey, null, 'anthropic_rejected_definitively');
        if (tracker) tracker.inFlight = null;
      }
      throw err;
    }
    if (tracker && tracker.inFlight) tracker.inFlight.opId = r.messageId;
    // Medición server-side (HD-V21-17): cargo por msg_… + reserva a 0, atómico. Error → reconciliación.
    { const lrCharge = markLostResultResendCharge(serverLlmChargeInput({
      ownerId, itemRunId: item.itemRunId, model: scriptModel, messageId: r.messageId, requestId: r.requestId, usage: r.usage,
      // r19 (#642): la condensación de un bloque largo es una corrección por validación (banda 85–110 %).
      callRole: role === 'continuation' ? 'continuation' : role === 'condense' ? 'validation_retry' : 'main',
      attempt: itemRole.attempt,
    }), item.outputSummary, item.attempt); await settlePaidCall(deps.finops, resKey, lrCharge, 'anthropic_measured'); await consumeLostResultMark(deps, item, lrCharge); }
    paidIds.push(r.messageId);
    if (tracker) {
      tracker.inFlight = null;
      tracker.unpersistedPaidOutput = { provider: 'anthropic', what, opIds: [...paidIds] };
    }
    // Fix round 1 (I4): la salida cortada por max_tokens se informa (nunca se acepta como un bloque completo).
    return { text: r.text, messageId: r.messageId, truncated: r.stopReason === 'max_tokens' };
  };
  /** Error de una llamada del guion → fallo con su clase (resultado conocido, presupuesto, lease o proveedor). */
  const scriptFailure = async (err: unknown, where: string): Promise<'stop'> => {
    if (err instanceof LeaseLost) throw err;
    if (err instanceof BudgetBlocked) return 'stop';
    // FinOps atómico (review I1): el tope se maneja arriba (pausa del run + devolución sin consumir intento).
    if (err instanceof RunBudgetCapReached) throw err;
    if (err instanceof AudioScriptError) return fail(deps, item, err.message, err.retryable, { knownOutcome: true });
    const e = err instanceof ProviderCallError ? err : null;
    return fail(deps, item, `audiobook_script_failed: ${where}: ${err instanceof Error ? err.message : String(err)}`, e ? e.retryable : true);
  };

  // ── 1. Plan + guion por bloque (solo los bloques que falten) ───────────────
  if (needsLlm) {
    plan = {
      v: 1, sha256: full.sha256, sourceWords: full.sourceWords, narratableWords: full.narratableWords, excluded: full.excluded,
      rawWords: full.rawWords, lostWords: full.lostWords,
      sections: full.sections.map((x) => ({ idx: x.idx, title: x.title, words: x.words, sha256: x.sha256 })),
    };
    await record(deps, item, { audiobookPlan: plan });
    if (!(await guard(deps, item, 'anthropic', llmCallEstimate(scriptModel, LLM_CALL_PROMPT_CHARS_BOUND, LLM_CALL_MAX_TOKENS_BOUND)))) return;
    for (const section of full.sections) {
      const k = String(section.idx);
      if (sections[k]?.sourceSha === section.sha256) continue; // ya pagado y aceptado
      // R16 (#1): entre bloques no hay gasto en el aire (el anterior ya quedó guardado).
      if (await handBackIfDraining(deps, item, `antes del guion del bloque ${section.idx + 1} (los anteriores ya están guardados)`)) return;
      const prevTail = sections[String(section.idx - 1)]?.text ?? null;
      let res;
      try {
        res = await generateSectionScript(input, section, full.sections.length, prevTail,
          llmFor(`sec${section.idx}`, `guion del bloque ${section.idx + 1} del audiolibro pagado sin persistir`, []));
      } catch (err) {
        await releaseUnitUnused(`sec${section.idx}`);
        await scriptFailure(err, `bloque ${section.idx + 1}/${full.sections.length}`);
        return;
      }
      await releaseUnitUnused(`sec${section.idx}`);
      sections[k] = {
        sourceSha: res.sourceSha, sourceWords: res.sourceWords, text: res.text, words: res.words, ratio: res.ratio,
        continued: res.continued, condensed: res.condensed, messageIds: res.messageIds, model: scriptModel,
      };
      // Idempotencia: el guion aceptado del bloque queda guardado — un re-claim no vuelve a pagarlo.
      await record(deps, item, { audiobookSections: sections });
      if (tracker) tracker.unpersistedPaidOutput = null;
    }
  }
  const p = plan as PersistedAudiobookPlan;
  const blockTexts = () => p.sections.map((x) => ({
    idx: x.idx,
    text: sections[String(x.idx)].text,
    extensions: (extensions[String(x.idx)] ?? []).filter((e) => e.sourceSha === x.sha256).map((e) => e.text),
  }));
  const narrated = (b: { text: string; extensions: string[] }) => [b.text, ...b.extensions].join(' ');
  const sources = p.sections.map((x) => ({ idx: x.idx, text: srcBySha.get(x.sha256)?.text ?? '' }));

  /**
   * Anti-duplicado / anti-bucle (bloques entre sí y DENTRO de un bloque); descarta y falla → el reintento regenera
   * SOLO lo descartado. Fix round 2: dos pasadas.
   *  1. Guiones principales solos: una repetición ahí descarta esos bloques (como antes).
   *  2. Principales + ampliaciones: como los principales ya pasaron (1), toda repetición nueva la introduce una
   *     AMPLIACIÓN → se descartan solo las ampliaciones de los bloques implicados. El guion principal, validado
   *     y pagado, se conserva y se reutiliza (nunca se vuelve a comprar).
   */
  const repetitionGate = async (): Promise<boolean> => {
    const blocks = blockTexts();
    const main = findScriptRepetition(blocks.map((b) => ({ idx: b.idx, text: b.text })), sources);
    if (main.idxs.length) {
      const dropped: string[] = [];
      for (const i of blocksToDropForRepetition(main.idxs)) {
        dropped.push(...(sections[String(i)]?.messageIds ?? []), ...(extensions[String(i)] ?? []).flatMap((e) => e.messageIds));
        delete sections[String(i)];
        delete extensions[String(i)];
      }
      discarded.push(...dropped);
      await record(deps, item, { audiobookSections: sections, audiobookExtensions: extensions, audiobookDiscardedOps: [...discarded] });
      await fail(deps, item, `AUDIOBOOK_SCRIPT_REPETITION: ${main.detail} (capítulo ${item.chapterNumber ?? '?'}; se regeneran solo esos bloques)`, true, { knownOutcome: true });
      return false;
    }
    const all = findScriptRepetition(blocks.map((b) => ({ idx: b.idx, text: narrated(b) })), sources);
    if (!all.idxs.length) return true;
    const withExt = all.idxs.filter((i) => (extensions[String(i)] ?? []).length > 0);
    if (!withExt.length) throw new Error(`repetición sin ampliaciones tras validar los guiones principales (${all.detail})`); // inalcanzable
    const dropped: string[] = [];
    for (const i of withExt) {
      dropped.push(...(extensions[String(i)] ?? []).flatMap((e) => e.messageIds));
      delete extensions[String(i)];
    }
    discarded.push(...dropped);
    await record(deps, item, { audiobookExtensions: extensions, audiobookDiscardedOps: [...discarded] });
    await fail(deps, item, `AUDIOBOOK_SCRIPT_REPETITION: ${all.detail} (capítulo ${item.chapterNumber ?? '?'}; la repite una ampliación: se descartan solo las ampliaciones de los bloques ${withExt.map((i) => i + 1).join(', ')}; el guion principal se conserva)`, true, { knownOutcome: true });
    return false;
  };

  // ── 2. Anti-duplicado / anti-bucle sobre el guion completo ─────────────────
  if (!(await repetitionGate())) return;
  if (needsLlm && !(await guard(deps, item, 'openai', ttsCallEstimate(model, TTS_MAX_CHARS)))) return; // el LLM gastó

  // ── 3. Segmentos de TTS (solo los que falten o estén inválidos) ────────────
  const tts = new OpenAiTtsClient(openaiKey, env);
  const segBase = storageBase(item, ownerId, 'dynamic_audio_segment');
  let reused = 0;
  type Synth = { segs: ReturnType<typeof audiobookSegments>; parts: Buffer[]; manifestSegs: AudiobookManifestSegment[] };
  /** Sintetiza (o reutiliza) todos los segmentos del guion actual. null = el item ya quedó devuelto/fallado. */
  const synthesize = async (): Promise<Synth | null> => {
    const segs = audiobookSegments(blockTexts());
    if (!segs.length) await fail(deps, item, `AUDIO_SCRIPT_EMPTY: ${item.itemKey} no tiene texto para narrar`, false);
    const parts: Buffer[] = [];
    const manifestSegs: AudiobookManifestSegment[] = [];
    for (let k = 0; k < segs.length; k++) {
      const seg = segs[k];
      const prev = segState[seg.key];
      if (prev && prev.textSha === seg.textSha && typeof prev.storagePath === 'string') {
        if (!deps.artifacts.downloadStorageObject) throw new Error('dynamic-provider-worker: artifacts sin downloadStorageObject (modo real)');
        let buf: Buffer;
        try {
          buf = await deps.artifacts.downloadStorageObject(ARTIFACTS_BUCKET, prev.storagePath);
        } catch (err) {
          // Sin gasto: el segmento pagado sigue en el Storage; se reintenta la descarga (nunca se repaga).
          await fail(deps, item, `audio_segment_unavailable: ${seg.key} (${err instanceof Error ? err.message : String(err)}); se reintenta sin volver a sintetizar`, true);
          return null;
        }
        let info: ReturnType<typeof mp3FrameInfo> | null = null;
        try { info = mp3FrameInfo(buf); } catch { info = null; }
        if (info && sha256(buf) === prev.audioSha && info.frames === prev.frames) {
          parts.push(buf);
          manifestSegs.push({ key: seg.key, sectionIdx: seg.sectionIdx, partIdx: seg.partIdx, words: seg.words, chars: seg.chars, textSha: seg.textSha,
            audioSha: prev.audioSha, frames: prev.frames, seconds: prev.seconds, bitrateKbps: prev.bitrateKbps, requestId: prev.requestId, storagePath: prev.storagePath });
          reused++;
          continue;
        }
        // Guardado pero corrupto (sha o frames distintos): es INVÁLIDO → se regenera solo este segmento. Su operación
        // pagada queda anotada como descartada a sabiendas (resultado conocido): nunca bloquea un intento posterior.
        deps.logger.warn(`Item ${item.itemKey}: el segmento ${seg.key} guardado no coincide con su manifiesto — se vuelve a sintetizar`);
        delete segState[seg.key];
        if (prev.requestId) discarded.push(prev.requestId);
        await record(deps, item, { audioSegments: segState, audiobookDiscardedOps: [...discarded] });
      }
      // R16 (#1): entre segmentos no hay gasto en el aire (los anteriores ya están guardados).
      if (await handBackIfDraining(deps, item, `antes del segmento ${k + 1}/${segs.length} del audio (los anteriores ya están guardados)`)) return null;
      await heartbeat(deps, item);
      // Fix round 1 (I5): el guard reserva el costo de ESTE segmento (no el p90 del capítulo entero).
      if (!(await guard(deps, item, 'openai', ttsCallEstimate(model, seg.chars)))) return null;
      // Calibración #2: reserva DURABLE del segmento antes de llamar (si falla, no se llama a OpenAI).
      const resKey = await reservePaidCall(deps.finops, {
        kind: 'tts', ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt,
        tag: `seg:${seg.key}`, estimate: { characters: seg.chars, model }, sendMarked: true,
      });
      if (tracker) tracker.inFlight = { provider: 'openai', key: resKey };
      // r62 (E2E M): marca DURABLE de envío justo antes de llamar: si el worker muere entre la reserva y el envío, el
      // próximo intento ve la reserva sin marca (`sendMarked` sin `paidCallsSent`) y la libera sola (nunca salió).
      await markPaidCallSent(deps, item, resKey);
      let res;
      try {
        res = await tts.speech({ model, voice, input: seg.text });
      } catch (err) {
        const e = err instanceof ProviderCallError ? err : null;
        if (isDefinitiveRejection(err)) {
          await settlePaidCall(deps.finops, resKey, null, 'openai_tts_rejected_definitively');
          if (tracker) tracker.inFlight = null;
        }
        const knownHttp = isKnownTransientHttpError(err);
        if (knownHttp) {
          // r62 (K2): respuesta de error del proveedor = sin cobro → se libera la reserva y se reintenta (clase A).
          await settlePaidCall(deps.finops, resKey, null, 'openai_tts_http_error_not_charged');
          if (tracker) tracker.inFlight = null;
        }
        // «persisted k»: los k segmentos anteriores ya están guardados → ningún trozo pagado sin guardar (clase A).
        await fail(deps, item, `tts_failed: chunk ${k + 1}/${segs.length} (persisted ${k}): ${err instanceof Error ? err.message : String(err)}`, knownHttp ? true : e ? e.retryable : true,
          knownHttp ? { knownOutcome: true } : {});
        return null;
      }
      if (tracker && tracker.inFlight) tracker.inFlight.opId = res.requestId;
      let rawSeconds: number | null = null;
      try { rawSeconds = mp3DurationSeconds(res.audio); } catch { rawSeconds = null; }
      // r62 (E2E M, «resultado pagado perdido» — minimizarlo): el segmento se GUARDA (Storage + output_summary, con la
      // clave de su reserva) ANTES de liquidar. Un kill entre guardar y liquidar deja la reserva pendiente con su segmento
      // guardado: el próximo claim la liquida con el cargo medido (priorPaidBlock) y reutiliza el segmento, sin repagar.
      // Las fallas CONOCIDAS de abajo (audio inválido, ritmo, duplicado) liquidan primero (resultado conocido y pagado).
      let segSettled = false;
      const settleSeg = async () => {
        if (segSettled) return;
        { const lrCharge = markLostResultResendCharge(ttsChargeInput({
          ownerId, itemRunId: item.itemRunId, requestId: res.requestId, audioSeconds: rawSeconds, characters: seg.chars,
          model, generation: item.generation ?? 1, chunk: k, itemAttempt: item.attempt,
        }), item.outputSummary, item.attempt); await settlePaidCall(deps.finops, resKey, lrCharge, 'openai_tts_measured'); await consumeLostResultMark(deps, item, lrCharge); }
        segSettled = true;
        if (tracker) {
          tracker.inFlight = null;
          tracker.unpersistedPaidOutput = { provider: 'openai', what: `segmento ${seg.key} del audiolibro pagado sin persistir`, opIds: res.requestId ? [res.requestId] : [] };
        }
      };
      if (rawSeconds === null) await settleSeg();
      if (rawSeconds === null) await fail(deps, item, `TTS_AUDIO_INVALID: el segmento ${k + 1}/${segs.length} (${seg.key}) de ${item.itemKey} no es un MP3 medible`, true, { knownOutcome: true });
      // r19 A4: el audiolibro va a 48 kbps mono (transcode existente; sin ffmpeg → el original, como hoy).
      const buf = await transcodeMp3Bitrate(res.audio, AUDIOBOOK_TARGET_BITRATE_KBPS);
      let info: ReturnType<typeof mp3FrameInfo>;
      try {
        info = mp3FrameInfo(buf);
      } catch (err) {
        await settleSeg();
        await fail(deps, item, `TTS_AUDIO_INVALID: el segmento ${seg.key} no es un MP3 válido tras el transcode (${err instanceof Error ? err.message : String(err)})`, true, { knownOutcome: true });
        return null;
      }
      const wpm = wpmOf(seg.words, info.seconds);
      if (seg.words >= AUDIOBOOK_WPM_MIN_WORDS && (wpm < AUDIOBOOK_WPM_MIN || wpm > AUDIOBOOK_WPM_MAX)) {
        // Voz ralentizada, relleno o bucle: el segmento NO se guarda como válido → el reintento lo regenera.
        await settleSeg();
        await fail(deps, item, `AUDIO_WPM_OUT_OF_RANGE: el segmento ${seg.key} narra ${seg.words} palabras en ${info.seconds.toFixed(2)} s (${wpm} ppm; aceptado ${AUDIOBOOK_WPM_MIN}–${AUDIOBOOK_WPM_MAX})`, true, { knownOutcome: true });
        return null;
      }
      const audioSha = sha256(buf);
      const dup = Object.entries(segState).find(([key, g]) => key !== seg.key && g.audioSha === audioSha);
      if (dup) {
        await settleSeg();
        await fail(deps, item, `AUDIOBOOK_SEGMENT_DUPLICATE: el audio del segmento ${seg.key} es idéntico al de ${dup[0]}`, true, { knownOutcome: true });
        return null;
      }
      if (!deps.artifacts.putStorageObject) throw new Error('dynamic-provider-worker: artifacts sin putStorageObject (modo real)');
      // Ruta por intento: nunca choca con un objeto de un intento anterior del mismo segmento.
      const storagePath = `${segBase}/${seg.key}.a${item.attempt}.mp3`;
      await deps.artifacts.putStorageObject({ storagePath, buffer: buf, mimeType: 'audio/mpeg', upsert: false });
      segState[seg.key] = {
        sectionIdx: seg.sectionIdx, partIdx: seg.partIdx, textSha: seg.textSha, audioSha, frames: info.frames, seconds: info.seconds,
        bitrateKbps: info.bitrateKbps, requestId: res.requestId, storagePath, bytes: buf.length, words: seg.words, chars: seg.chars,
        // r62: para liquidar al reanudar si el worker murió entre guardar y liquidar.
        reservationKey: resKey, rawSeconds, model, segIndex: k, attempt: item.attempt,
      };
      await record(deps, item, { audioSegments: segState });
      // r62 (review lost_result M4): guardado → nada en el aire. Si la liquidación falla, es un transitorio: el próximo
      // claim liquida el segmento guardado con su medición (priorPaidBlock) sin gastar el único reenvío ambiguo.
      if (tracker) { tracker.inFlight = null; tracker.unpersistedPaidOutput = null; }
      segSettled = false;
      try { await settleSeg(); } finally { if (tracker) { tracker.inFlight = null; tracker.unpersistedPaidOutput = null; } }
      parts.push(buf);
      manifestSegs.push({ key: seg.key, sectionIdx: seg.sectionIdx, partIdx: seg.partIdx, words: seg.words, chars: seg.chars, textSha: seg.textSha,
        audioSha, frames: info.frames, seconds: info.seconds, bitrateKbps: info.bitrateKbps, requestId: res.requestId, storagePath });
    }
    return { segs, parts, manifestSegs };
  };
  const concat = async (parts: Buffer[]): Promise<{ mp3: Buffer; audio: ReturnType<typeof mp3FrameInfo> } | null> => {
    try {
      // UX r18: concatMp3 escribe el frame Info con el conteo REAL de frames (solo aquí; el transcode genérico no).
      const mp3 = concatMp3(parts);
      return { mp3, audio: mp3FrameInfo(mp3) };
    } catch (err) {
      await fail(deps, item, `TTS_AUDIO_INVALID: ${err instanceof Error ? err.message : String(err)}`, true, { knownOutcome: true });
      return null;
    }
  };
  const blockWords = (idx: number) => {
    const sc = sections[String(idx)];
    const ext = (extensions[String(idx)] ?? []).filter((e) => e.sourceSha === sc.sourceSha);
    return sc.words + ext.reduce((a, e) => a + e.words, 0);
  };

  let synth = await synthesize();
  if (!synth) return;
  let built = await concat(synth.parts);
  if (!built) return;

  // ── 4. Duración objetivo del capítulo (fix round 1, I1) ────────────────────
  // T_ch = 0,85 × palabras de fuente × 60 / 141 s. Con Σ fuente ≥ umbral, Σ T_ch ≥ 1500 s: el piso del curso
  // queda garantizado por construcción. Si el capítulo quedó corto (voz rápida o guion condensado), UNA pasada
  // por intento amplía desde su propia fuente los bloques de menor ratio (tope 110 %, +25 % por pasada).
  const target = chapterTargetSeconds(p.narratableWords);
  if (built.audio.seconds + 1e-6 < target) {
    const sentWords = synth.manifestSegs.reduce((a, x) => a + x.words, 0);
    const wpm = Math.max(1, sentWords / (built.audio.seconds / 60));
    const deficitWords = Math.ceil(((target - built.audio.seconds) * wpm) / 60 * 1.02);
    const picks = planChapterExtension(p.sections.map((x) => ({ idx: x.idx, sourceWords: x.words, scriptWords: blockWords(x.idx) })), deficitWords);
    if (!picks.length) {
      return fail(deps, item, `AUDIOBOOK_CHAPTER_UNDER_TARGET: el capítulo ${item.chapterNumber ?? '?'} dura ${built.audio.seconds.toFixed(0)} s (< ${target.toFixed(0)} s = 0,85 × ${p.narratableWords} palabras a ${AUDIOBOOK_WPM_REF} ppm) y ningún bloque tiene margen bajo el 110 % de su fuente; no se completa`, true, { knownOutcome: true });
    }
    if (!anthropicKey) await fail(deps, item, notReady(item, ['ANTHROPIC_API_KEY']), false);
    for (const pick of picks) {
      const x = p.sections.find((s) => s.idx === pick.idx) as PersistedAudiobookPlan['sections'][number];
      const src = srcBySha.get(x.sha256);
      if (!src) continue; // el Markdown cambió: el bloque no se amplía (sin gasto)
      const k = String(x.idx);
      const maxWords = Math.floor(AUDIOBOOK_MAX_RATIO * x.words) - blockWords(x.idx);
      const existing = [sections[k].text, ...(extensions[k] ?? []).map((e) => e.text)].join(' ');
      let ext;
      try {
        ext = await generateSectionExtension(input, src, existing, pick.words, maxWords,
          llmFor(`ext${x.idx}-${(extensions[k] ?? []).length}`, `ampliación del bloque ${x.idx + 1} del audiolibro pagada sin persistir`, []));
      } catch (err) {
        await scriptFailure(err, `ampliación del bloque ${x.idx + 1}`);
        return;
      }
      if (ext.words > 0) {
        extensions[k] = [...(extensions[k] ?? []), { sourceSha: x.sha256, text: ext.text, words: ext.words, messageIds: ext.messageIds }];
      } else {
        discarded.push(...ext.messageIds); // ampliación vacía (cortada sin oración completa): pagada y descartada a sabiendas
      }
      await record(deps, item, { audiobookExtensions: extensions, audiobookDiscardedOps: [...discarded] });
      if (tracker) tracker.unpersistedPaidOutput = null;
    }
    if (!(await repetitionGate())) return;
    synth = await synthesize();
    if (!synth) return;
    built = await concat(synth.parts);
    if (!built) return;
    if (built.audio.seconds + 1e-6 < target) {
      return fail(deps, item, `AUDIOBOOK_CHAPTER_UNDER_TARGET: el capítulo ${item.chapterNumber ?? '?'} dura ${built.audio.seconds.toFixed(0)} s tras ampliar ${picks.length} bloque(s) desde su fuente (objetivo ${target.toFixed(0)} s); el reintento amplía lo que quede bajo el 110 %. No se completa`, true, { knownOutcome: true });
    }
  }
  const { segs, parts, manifestSegs } = synth;
  const { mp3, audio } = built;

  // ── 5. Manifiesto validado ANTES de completar ──────────────────────────────
  const scriptSections = p.sections.map((x) => {
    const sc = sections[String(x.idx)];
    const ext = (extensions[String(x.idx)] ?? []).filter((e) => e.sourceSha === x.sha256);
    const words = blockWords(x.idx);
    return {
      idx: x.idx, title: x.title, sourceWords: x.words, sourceSha: x.sha256, scriptWords: words,
      ratio: Math.round((words / Math.max(1, x.words)) * 1000) / 1000, continued: sc.continued || ext.length > 0,
      messageIds: [...sc.messageIds, ...ext.flatMap((e) => e.messageIds)],
    };
  });
  const scriptWords = scriptSections.reduce((a, x) => a + x.scriptWords, 0);
  const wordsSent = manifestSegs.reduce((a, x) => a + x.words, 0);
  const manifest: AudiobookChapterManifest = {
    v: AUDIOBOOK_MANIFEST_VERSION,
    chapterId: item.chapterId as string,
    source: {
      words: p.sourceWords, narratableWords: p.narratableWords, sections: p.sections.length, sha256: p.sha256, excluded: p.excluded,
      rawWords: p.rawWords ?? null, lostWords: p.lostWords ?? null,
    },
    script: { words: scriptWords, ratio: Math.round((scriptWords / Math.max(1, p.narratableWords)) * 1000) / 1000, sections: scriptSections },
    tts: {
      wordsSent,
      charsSent: manifestSegs.reduce((a, x) => a + x.chars, 0),
      segmentsExpected: segs.length,
      segmentsGenerated: manifestSegs.length,
      segmentsConcatenated: parts.length,
      segments: manifestSegs,
    },
    audio: {
      frames: audio.frames,
      seconds: audio.seconds,
      infoFrames: audio.infoFrames,
      infoFrameSeconds: audio.infoFrames === null ? null : (audio.infoFrames * audio.samples) / audio.sampleRate,
      bitrateKbps: audio.bitrateKbps,
      wpm: wpmOf(wordsSent, audio.seconds),
      targetSeconds: target,
    },
  };
  const problems = validateChapterAudioManifest(manifest);
  if (problems.length) {
    return fail(deps, item, `AUDIOBOOK_MANIFEST_INVALID: ${problems.slice(0, 8).join('; ')} (capítulo ${item.chapterNumber ?? '?'}; no se completa)`, true, { knownOutcome: true });
  }
  if (audio.bitrateKbps !== AUDIOBOOK_TARGET_BITRATE_KBPS) {
    deps.logger.warn(`Item ${item.itemKey}: el audiolibro quedó a ${audio.bitrateKbps ?? 'VBR'} kbps (esperado ${AUDIOBOOK_TARGET_BITRATE_KBPS}; ¿ffmpeg ausente en el worker?)`);
  }
  const fullScript = blockTexts().map(narrated).join('\n\n');
  const messageIds = scriptSections.flatMap((x) => x.messageIds);
  if (!deps.artifacts.uploadBufferArtifact) throw new Error('dynamic-provider-worker: artifacts sin uploadBufferArtifact (modo real)');
  const entity = item.chapterId ?? 'course';
  const row = await deps.artifacts.uploadBufferArtifact({
    ownerId,
    courseId: item.artifactCourseId,
    jobId: item.runId,
    type: 'dynamic_audio_mp3',
    filename: `${entity}.${item.type}.mp3`,
    storagePath: `${storageBase(item, ownerId, 'dynamic_audio_mp3')}/a${item.attempt}.mp3`,
    buffer: mp3,
    mimeType: 'audio/mpeg',
    metadata: {
      manifestId: item.manifestId, itemKey: item.itemKey, chapterId: item.chapterId, mode: 'real', provider: 'openai',
      model, voice, durationSeconds: audio.seconds, chunks: segs.length, requestIds: manifestSegs.map((x) => x.requestId),
      scriptSha256: sha256(fullScript), words: scriptWords, messageIds, scriptModel, audiobookManifest: manifest,
    },
    upsert: false,
  });
  const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
    artifactIds: [row.id],
    summary: {
      mode: 'real', provider: 'openai', model, voice, durationSeconds: audio.seconds, chunks: segs.length, scriptSha256: sha256(fullScript),
      words: scriptWords, messageIds, scriptModel, reusedSegments: reused, audiobookManifest: manifest,
      ...(audio.bitrateKbps !== AUDIOBOOK_TARGET_BITRATE_KBPS ? { bitrateWarning: `audiolibro a ${audio.bitrateKbps ?? 'VBR'} kbps (esperado ${AUDIOBOOK_TARGET_BITRATE_KBPS})` } : {}),
    },
  });
  if (!ok) deps.logger.warn(`Item ${item.itemKey}: audiolibro subido (artifact ${row.id}) pero completeItem devolvió false (lease perdida)`);
}

/** Despacho del modo real. La lease perdida corta en silencio (otro ejecutor sigue). */
export async function processRealProviderItem(deps: RealProviderDeps, item: ClaimedItem, ownerId: string): Promise<void> {
  // r61 (Q-21): cerco por intento dentro del proceso (mismo executorId): una tarea vieja de esta parte, si este proceso
  // la vuelve a reclamar, deja de escribir en ella (sus escrituras del scheduler responden «lease perdida»).
  const fenceToken = PROCESS_ITEM_FENCE.enter(item.itemRunId);
  deps = { ...deps, scheduler: fencedScheduler(deps.scheduler, item.itemRunId, fenceToken) };
  const tracked: RealProviderDeps = { ...deps, tracker: deps.tracker ?? newPaidCallTracker() };
  try {
    // Calibración #2 — detección DURABLE: una operación pagada de un intento anterior sin resultado
    // persistido (reserva sin liquidar, o cargo sin salida) nunca se vuelve a pagar sola.
    const blocked = await priorPaidBlock(tracked, item, ownerId);
    if (blocked) return;
    if (item.type === 'presentation') await processRealPresentation(tracked, item, ownerId);
    else await processRealAudio(tracked, item, ownerId);
  } catch (err) {
    const amb = trackerAmbiguity(tracked.tracker);
    if (err instanceof LeaseLost) {
      if (amb) deps.logger.error(`Item ${item.itemKey}: lease perdida con gasto sin resultado persistido (${amb.provider}) — el próximo claim NO reenvía (queda en reconciliación por el ledger)`);
      else deps.logger.warn(`Item ${item.itemKey}: lease perdida en modo real — se detiene (el próximo claim retoma sin reenviar)`);
      return;
    }
    if (err instanceof ProviderItemFailed) {
      if (err.retryable) return; // ya quedó `retrying` con su motivo
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    if (amb) {
      // Después de una llamada pagada (DB caída al liquidar/persistir, error inesperado): reconciliación.
      const msg = reconciliationMessage(amb.provider, amb.what, `${detail}${amb.opIds.length ? ` (operación del proveedor: ${amb.opIds.join(', ')})` : ''}`);
      deps.logger.error(`Item ${item.itemKey}: ${msg}`);
      await deps.scheduler.failItem(item.itemRunId, deps.executorId, msg.slice(0, 1900), false);
      throw new ProviderItemFailed(msg, false);
    }
    if (err instanceof RunBudgetCapReached) {
      // FinOps atómico: la reserva de la próxima llamada excedería el tope del run → no se llamó (0 gasto). Run
      // pausado (run_budget_cap) y la parte vuelve a la cola sin consumir intento (igual que el guard).
      await pauseRunForCap(deps.budget, err).catch(() => false);
      await deps.scheduler.failItem(item.itemRunId, deps.executorId, runPausedHandbackMessage(item.type), true, undefined, {
        retryAfterSeconds: DRAIN_HANDBACK_RETRY_SECONDS, grantAttempt: true,
      });
      deps.logger.warn(`Item ${item.itemKey}: ${err.message} — devuelto sin llamar al proveedor`);
      return;
    }
    if (err instanceof LedgerWriteFailed && !deps.finops) {
      // Worker real sin ledger FinOps: configuración, no transitorio. Nunca se llamó al proveedor.
      const msg = `finops_unavailable: ${detail}. No se llamó al proveedor (sin gasto); corregí la configuración del worker.`;
      deps.logger.error(`Item ${item.itemKey}: ${msg}`);
      await deps.scheduler.failItem(item.itemRunId, deps.executorId, msg.slice(0, 1900), false);
      throw new ProviderItemFailed(msg, false);
    }
    // Antes de cualquier llamada pagada (p.ej. DB caída en el guard o la reserva): reintentable, 0 llamadas.
    const msg = `unexpected_error: ${detail}`;
    deps.logger.error(`Item ${item.itemKey}: ${msg}`);
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, msg.slice(0, 1900), true);
  } finally {
    // La copia en memoria de los marcadores de envío vive solo mientras se procesa el item (lo durable está en el
    // item): un worker de larga vida no acumula una entrada por item procesado.
    if (PROCESS_ITEM_FENCE.isCurrent(item.itemRunId, fenceToken)) sentByItem.delete(item.itemRunId);
    PROCESS_ITEM_FENCE.leave(item.itemRunId, fenceToken);
  }
}

/**
 * r62 (review lost_result, duda 3): la marca del reenvío por resultado perdido se CONSUME en el intento que de verdad
 * reenvía (el primero que registra un cargo marcado), aunque no sea N+1 (p. ej. N+1 cayó antes de llegar al proveedor).
 */
async function consumeLostResultMark(deps: RealProviderDeps, item: ClaimedItem, charge: { metadata?: Record<string, unknown> | null } | null): Promise<void> {
  const patch = lostResultConsumeMark(item.outputSummary, item.attempt, charge);
  if (!patch) return;
  item.outputSummary = { ...(item.outputSummary ?? {}), ...patch };
  await record(deps, item, patch).catch((e) => deps.logger.warn(`Item ${item.itemKey}: no se pudo registrar el consumo de la marca lost_result (${e instanceof Error ? e.message : String(e)})`));
}

/** r62: reservas pendientes de intentos anteriores de un item cuyo audio YA quedó subido → cobradas (conservador). */
async function settleUploadedUnitReservations(deps: RealProviderDeps, item: ClaimedItem): Promise<void> {
  const l = deps.finops;
  if (!l || !l.itemPaidCharges || typeof l.reconcileReservationAsCharged !== 'function') return;
  const rows = await l.itemPaidCharges(item.itemRunId).catch(() => []);
  for (const r of rows) {
    if (!r.reservation || r.settled || r.attempt >= item.attempt) continue;
    await l.reconcileReservationAsCharged(r.idempotency_key, 'auto: audio ya subido con la reserva sin liquidar (kill entre subir y liquidar); se cuenta su cota', {
      decidedBy: 'system', recordedBy: 'auto-recovery', metadata: { auto: true, resultPersisted: true, rule: 'r62_lost_result' },
    }).catch((e) => deps.logger.warn(`Item ${item.itemKey}: no se pudo liquidar ${r.idempotency_key} (${e instanceof Error ? e.message : String(e)})`));
  }
}

/** Item bloqueado por una operación pagada previa sin resultado → true (ya quedó en reconciliación). */
async function priorPaidBlock(deps: RealProviderDeps, item: ClaimedItem, ownerId: string): Promise<boolean> {
  // Sin ledger cableado, la configuración se valida primero; la reserva (antes de cualquier llamada)
  // falla después con finops_unavailable (fail closed, 0 llamadas).
  if (!deps.finops) return false;
  // Review I4: el MP3 pagado YA quedó subido (artifact del item) y lo que falló fue completar el item
  // (p.ej. DB caída en completeItem): se reutiliza ese artifact y se completa, 0 llamadas nuevas.
  if (item.type === 'audio_welcome' || item.type === 'audiobook_chapter') {
    // El artifact se vincula al item recién en completeItem: se lo identifica por el run + el prefijo de
    // Storage del item (incluye su idempotencyKey, distinta por generación) + metadata real.
    const prefix = `${storageBase(item, ownerId, 'dynamic_audio_mp3')}/`;
    const [prev] = await deps.dataSource.query(
      `select id, metadata from public.artifacts
        where job_id = $1 and type = 'dynamic_audio_mp3' and left(storage_path, length($2)) = $2
          and metadata->>'mode' = 'real' and metadata->>'itemKey' = $3
        order by created_at desc limit 1`,
      [item.runId, prefix, item.itemKey],
    );
    if (prev) {
      const m = (prev.metadata ?? {}) as Record<string, any>;
      deps.logger.warn(`Item ${item.itemKey}: el audio ya estaba subido (artifact ${prev.id}) — se completa sin volver a llamar a OpenAI`);
      // r62 (E2E M): el worker murió entre subir y liquidar → las reservas de esos trozos siguen pendientes: se liquidan
      // como cobradas (conservador: su cota; el resultado existe, no es un duplicado) para no dejarlas abiertas.
      await settleUploadedUnitReservations(deps, item);
      const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
        artifactIds: [prev.id],
        summary: {
          mode: 'real', provider: 'openai', model: m.model ?? null, voice: m.voice ?? null, durationSeconds: m.durationSeconds ?? null, chunks: m.chunks ?? null, reusedUploadedArtifact: true,
          // r19: el manifiesto validado viaja con el artifact (el empaque lo lee del summary del item).
          ...(m.audiobookManifest ? { audiobookManifest: m.audiobookManifest } : {}),
        },
      });
      if (!ok) deps.logger.warn(`Item ${item.itemKey}: completeItem devolvió false al reutilizar el audio (lease perdida)`);
      return true;
    }
  }
  const os = (item.outputSummary ?? {}) as Record<string, any>;
  const ext = (os.external ?? {}) as Record<string, any>;
  const skip: string[] = [];
  // Gamma con generationId persistido = reanudable (poll gratis, nunca reenvía).
  if (item.type === 'presentation' && typeof ext.gammaGenerationId === 'string') skip.push('gamma');
  // Guion del audiolibro (pre-r19, un solo guion por capítulo) persistido: su LLM ya quedó guardado.
  if (os.audiobookScript && typeof os.audiobookScript.text === 'string' && os.audiobookScript.text.trim()) skip.push('anthropic');
  // r19: bloques del guion y segmentos de TTS guardados = su operación pagada ya tiene resultado persistido
  // (se reutiliza, nunca se repaga); solo una operación SIN resultado guardado bloquea.
  const persisted = item.type === 'audiobook_chapter' ? persistedAudiobookOps(os) : new Set<string>();
  // r62 (E2E M): un segmento GUARDADO cuya reserva quedó pendiente (kill entre guardar y liquidar) se liquida acá con su
  // cargo medido (idempotente por x-request-id): su resultado existe, no hay nada ambiguo ni que repagar.
  if (item.type === 'audiobook_chapter' && deps.finops.itemPaidCharges) {
    const segs = Object.values((os.audioSegments ?? {}) as Record<string, PersistedSegment>).filter((g) => g && typeof g.reservationKey === 'string' && g.requestId);
    if (segs.length) {
      const open = new Set((await deps.finops.itemPaidCharges(item.itemRunId)).filter((r) => r.reservation && !r.settled).map((r) => r.idempotency_key));
      for (const g of segs) {
        if (!open.has(g.reservationKey as string)) continue;
        const att = Number(g.attempt) || Number(/:a(\d+):/.exec(String(g.reservationKey))?.[1] ?? item.attempt);
        await settlePaidCall(deps.finops, g.reservationKey as string, ttsChargeInput({
          ownerId, itemRunId: item.itemRunId, requestId: g.requestId, audioSeconds: g.rawSeconds ?? null, characters: g.chars,
          model: g.model || 'gpt-4o-mini-tts', generation: item.generation ?? 1, chunk: typeof g.segIndex === 'number' ? g.segIndex : g.partIdx, itemAttempt: att,
        }), 'openai_tts_measured_on_resume');
      }
    }
  }
  const markedKey = typeof os.externalReservationKey === 'string' ? os.externalReservationKey : null;
  const { blocking, releasable } = await priorPaidOperations(deps.finops, item.itemRunId, {
    currentAttempt: item.attempt,
    acknowledgedThroughAttempt: Number(os.reconciliationAcknowledgedThroughAttempt ?? 0),
    skipProviders: skip,
    isPersistedOutput: (r) => !r.reservation && !!r.external_operation_id && persisted.has(r.external_operation_id),
    // Gamma: el marcador de envío se escribe DESPUÉS de la reserva y ANTES de llamar. Una reserva de
    // Gamma sin marcador que la nombre = la llamada nunca se hizo → se libera.
    isSubmitMarked: (key, row) => {
      if (key.startsWith('reservation:gamma:')) return key === markedKey;
      // r62 (E2E M): reserva con marca durable de envío (segmento del audiolibro) → enviada solo si tiene su marca.
      if (row && row.send_marked) return !!(os[PAID_CALLS_SENT_KEY] && typeof os[PAID_CALLS_SENT_KEY] === 'object' && os[PAID_CALLS_SENT_KEY][key]);
      // Review r2 (N1): reserva de unidad sin marcador de envío = nunca salió → liberable.
      if (isUnitReservationKey(key)) return !!(os[PAID_CALLS_SENT_KEY] && typeof os[PAID_CALLS_SENT_KEY] === 'object' && os[PAID_CALLS_SENT_KEY][key]);
      return true;
    },
  });
  // r61 (Q-21): ANTES de liberar nada — una reserva enviada y sin liquidar de un intento anterior que todavía puede
  // estar en vuelo (lease tomada) no se decide aún: el item vuelve a la cola sin llamar (sin consumir intento). Su envío
  // se fecha con el marcador (paidCallsSent / externalSubmitStartedAt) o, sin marcador, con el alta de la reserva.
  const sentMarks = (os[PAID_CALLS_SENT_KEY] && typeof os[PAID_CALLS_SENT_KEY] === 'object') ? os[PAID_CALLS_SENT_KEY] as Record<string, string> : {};
  let inFlight: { left: number; provider: string } | null = null;
  for (const b of priorAttemptMayBeInFlight(item) ? blocking : []) {
    if (!b.reservation || b.settled) continue;
    const provider = providerOfReservationKey(b.idempotency_key) ?? b.provider;
    const sentAt = sentMarks[b.idempotency_key]
      ?? (b.idempotency_key === markedKey && typeof os.externalSubmitStartedAt === 'string' ? os.externalSubmitStartedAt : null)
      ?? b.created_at ?? null;
    const left = inFlightRemainingMs(sentAt, IN_FLIGHT_WINDOW_MS[provider] ?? 0);
    if (left > 0 && (!inFlight || left > inFlight.left)) inFlight = { left, provider };
  }
  if (inFlight && (await handBackPriorInFlight(deps, item, `una llamada pagada (${inFlight.provider})`, inFlight.left))) return true;
  for (const r of releasable) await settlePaidCall(deps.finops, r.idempotency_key, null, 'reserved_without_submit_marker');
  if (!blocking.length) return false;
  const what = blocking.map((b) => `${b.provider} ${b.external_operation_id ?? b.idempotency_key} (intento ${b.attempt})`).join('; ');
  // r62 (review lost_result M1): textos DISTINTOS — un cargo ya LIQUIDADO sin resultado guardado («sin resultado
  // persistido», el caso lost_result) vs. una reserva ENVIADA y sin liquidar («sin liquidar», ambiguo de K1).
  const pendingRes = blocking.some((b) => b.reservation && !b.settled);
  const msg = reconciliationMessage(
    blocking[0].provider,
    pendingRes ? 'operación pagada de un intento anterior enviada y sin liquidar' : 'operación pagada de un intento anterior sin resultado persistido',
    `${what}. No se llamó al proveedor en este intento.`,
  );
  deps.logger.error(`Item ${item.itemKey}: ${msg}`);
  void ownerId;
  return fail(deps, item, msg, false);
}
