// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 F2 — modo REAL del dynamic-provider-worker (review final I1):
//
//  presentation:<ch>  → Gamma (lógica probada de gamma-worker.ts: textOptions
//                       es-419, themeId, poll GET /generations/{id}, PDF,
//                       portada = página 1 con pdftoppm). slideCount medido con
//                       R9 `pdfPageCount`; artifact según el contrato R9.
//  audio_welcome      → OpenAI TTS del texto `welcome` del course_intro (sin LLM).
//  audiobook_chapter  → guion narrativo de UN capítulo con el LLM server-side
//                       (medido en el ledger) + OpenAI TTS. Duración medida con
//                       R10 `mp3DurationSeconds`.
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
//  - El guion del audiolibro se persiste en output_summary.audiobookScript al
//    validarse: un re-claim no vuelve a pagar el LLM.
//  - Las claves se leen del entorno en cada item y nunca se loguean.
// ─────────────────────────────────────────────────────────────────────────────
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
import { concatMp3, mp3DurationSeconds } from '../../package/audio';
import { transcodeMp3Bitrate } from '../../tts/mp3-transcode.util';
import type { ThemeFamilyId, ThemeMode } from '../../modules/theme-engine/types';
import {
  LedgerWriteFailed,
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
} from '../finops-worker-hooks';
import { AnthropicClient, GammaClient, OpenAiTtsClient, ProviderCallError } from './provider-clients';
import { CoverError, CoverRasterizer, GAMMA_COVER_RASTERIZER_UNAVAILABLE, pdftoppmRasterizer } from './pdf-cover';
import {
  AUDIOBOOK_SCRIPT_MODEL_DEFAULT,
  AUDIOBOOK_SCRIPT_MODEL_ENV,
  AudioScriptError,
  cleanAudioText,
  generateChapterScript,
  splitForTts,
  welcomeScriptFromCourseIntro,
} from './audio-scripts';

type Env = Record<string, string | undefined>;

export const GAMMA_NUM_CARDS = 10;
export const TTS_MODEL_DEFAULT = 'gpt-4o-mini-tts';
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

export interface RealProviderDeps {
  scheduler: Pick<SchedulerService, 'completeItem' | 'failItem'> &
    Partial<Pick<SchedulerService, 'blockItemForBudget' | 'recordItemExternal' | 'heartbeatItem'>>;
  dataSource: Pick<DataSource, 'query'>;
  artifacts: Pick<ArtifactsService, 'uploadJsonArtifact'> &
    Partial<Pick<ArtifactsService, 'uploadBufferArtifact' | 'putStorageObject' | 'getDownloadUrl'>>;
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
  opts: { knownOutcome?: boolean } = {},
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
  await deps.scheduler.failItem(item.itemRunId, deps.executorId, message.slice(0, 1900), retryable);
  throw new ProviderItemFailed(message, retryable);
}

/** Runtime guard antes de una llamada pagada NUEVA. false = item bloqueado (sin llamada). */
async function guard(deps: RealProviderDeps, item: ClaimedItem, provider?: string): Promise<boolean> {
  const g = await deps.budget.guardPaidSubmission({ runId: item.runId, itemRunId: item.itemRunId, itemType: item.type, ...(provider ? { provider } : {}) });
  if (g.allow) return true;
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

async function heartbeat(deps: RealProviderDeps, item: ClaimedItem): Promise<void> {
  if (!deps.scheduler.heartbeatItem) return;
  const ok = await deps.scheduler.heartbeatItem(item.itemRunId, deps.executorId, deps.leaseSeconds);
  if (!ok) throw new LeaseLost();
}

function notReady(item: ClaimedItem, what: string[]): string {
  return (
    `${PROVIDER_NOT_READY}: el item ${item.itemKey} (${item.type}) necesita ${what.join(', ')} en el entorno del worker; ` +
    'no se llamó al proveedor (sin gasto). Configurá lo que falta y reintentá esta parte.'
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

/** Cuerpo de la generación: el del legacy probado (gamma-worker.ts), sin las marcas PARTE A/B del layout V1. */
export function gammaGenerationBody(input: { chapterTitle: string; contentMarkdown: string; themeId: string }): Record<string, unknown> {
  return {
    inputText: `${input.chapterTitle}\n\n${cleanAudioText(input.contentMarkdown)}`,
    textMode: 'generate',
    format: 'presentation',
    numCards: GAMMA_NUM_CARDS,
    additionalInstructions:
      'La diapositiva 1 es la portada del capítulo y debe mostrar su título. ' +
      'El resto desarrolla el contenido en bloques temáticos coherentes, en español latinoamericano.',
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
    await gammaAmbiguous(
      deps, item, ownerId, String(item.outputSummary.externalSubmitStartedAt),
      `un envío empezó (${item.outputSummary.externalSubmitStartedAt}) y no registró el generationId (crash o lease perdida a mitad)`,
    );
    return;
  } else {
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
    const marker = new Date().toISOString();
    await record(deps, item, { externalSubmitStartedAt: marker, externalReservationKey: resKey });
    const tracker = deps.tracker;
    if (tracker) {
      tracker.inFlight = { provider: 'gamma', key: resKey };
      (tracker as any).gammaReservationKey = resKey;
    }
    try {
      generationId = await client.createGeneration(gammaGenerationBody({ chapterTitle, contentMarkdown: markdown, themeId: themeId! }));
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
    await record(deps, item, {
      external: { gammaGenerationId: generationId, gammaThemeId: themeId!, themeFamily, themeMode, acceptedAtAttempt: item.attempt },
    });
    // Id persistido: la generación es reanudable (poll gratis) → ya no es un gasto "en el aire".
    // La reserva sigue contando el gasto (p90) hasta el terminal, donde se liquida con los créditos medidos.
    if (tracker) tracker.inFlight = null;
  }

  // ── poll hasta completed/failed ────────────────────────────────────────────
  const client = new GammaClient(apiKey, env);
  const pollMs = deps.gammaPollMs ?? positiveInt(env.DYNAMIC_GAMMA_POLL_MS, 6000);
  const timeoutMs = deps.gammaTimeoutMs ?? positiveInt(env.DYNAMIC_GAMMA_TIMEOUT_MS, 5 * 60_000);
  const t0 = Date.now();
  let st = await pollOnce(deps, item, client, generationId!);
  while (st.status !== 'completed' && st.status !== 'failed') {
    if (Date.now() - t0 > timeoutMs) {
      // Reintentable: el próximo claim sigue polleando la MISMA generación.
      await fail(deps, item, `gamma_timeout: la generación ${generationId} no terminó en ${Math.round(timeoutMs / 1000)} s (se retoma sin reenviar)`, true);
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
      `gamma_generation_failed: la generación ${gid} falló en Gamma (${st.error ?? 'sin detalle'}). No se reenvía sola: ` +
        'regenerá la presentación para pedir una nueva.',
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
      'cobrada (quedó reservada en el ledger): no se reenvía automáticamente. Revisá la cuenta de Gamma y, si corresponde, ' +
      'pedí un reenvío explícito (retry con resubmitProvider=true).',
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
  const env = envOf(deps);
  const openaiKey = trimmed(env, 'OPENAI_API_KEY');
  const anthropicKey = trimmed(env, 'ANTHROPIC_API_KEY');
  const recorded = item.outputSummary?.audiobookScript as { text?: string; words?: number; messageIds?: string[]; model?: string } | undefined;
  const needsLlm = item.type === 'audiobook_chapter' && !(recorded && typeof recorded.text === 'string' && recorded.text.trim());

  // Guard (TTS) → configuración COMPLETA antes de la primera llamada pagada.
  if (!(await guard(deps, item))) return;
  const missing: string[] = [];
  if (!openaiKey) missing.push('OPENAI_API_KEY');
  if (needsLlm && !anthropicKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) await fail(deps, item, notReady(item, missing), false);

  let script: string;
  let scriptMeta: Record<string, unknown> = {};
  if (item.type === 'audio_welcome') {
    const text = await dependencyText(deps, item, ownerId, 'dynamic_course_intro_json');
    try {
      script = welcomeScriptFromCourseIntro(JSON.parse(text));
    } catch (err) {
      return fail(deps, item, err instanceof AudioScriptError ? err.message : `AUDIO_WELCOME_TEXT_MISSING: course_intro no es JSON (${err instanceof Error ? err.message : String(err)})`, false);
    }
  } else if (!needsLlm) {
    script = recorded!.text as string;
    scriptMeta = { words: recorded!.words ?? null, messageIds: recorded!.messageIds ?? [], model: recorded!.model ?? null, reused: true };
  } else {
    const markdown = markdownOf(await dependencyText(deps, item, ownerId, 'dynamic_content_md'));
    if (!(await guard(deps, item, 'anthropic'))) return;
    const model = trimmed(env, AUDIOBOOK_SCRIPT_MODEL_ENV) || AUDIOBOOK_SCRIPT_MODEL_DEFAULT;
    const llmClient = new AnthropicClient(anthropicKey, env);
    const itemRole = providerCallRoleOf(item.attempt);
    const tracker = deps.tracker;
    let llmCallIdx = 0;
    const llmMessageIds: string[] = [];
    let result;
    try {
      result = await generateChapterScript(
        {
          courseTitle: item.blueprint?.course?.title ?? 'este curso',
          chapterNumber: item.chapterNumber ?? 0,
          chapterTitle: item.blueprint?.chapter?.title ?? `Capítulo ${item.chapterNumber ?? '?'}`,
          sector: (item.context?.courseContext as any)?.sector ?? null,
          nivel: (item.context?.courseContext as any)?.nivel ?? null,
          contentMarkdown: markdown,
        },
        async (prompt, role) => {
          await heartbeat(deps, item);
          // Fix round 1 (review f12 m3): la continuación es otra llamada pagada → vuelve a pasar el guard.
          if (role === 'continuation' && !(await guard(deps, item, 'anthropic'))) throw new BudgetBlocked();
          // Calibración #2: reserva DURABLE antes de la llamada (si falla, no se llama).
          const resKey = await reservePaidCall(deps.finops, {
            kind: 'llm', ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt,
            tag: `script-${role}-${llmCallIdx++}`,
            estimate: { promptChars: prompt.system.length + prompt.user.length, maxTokens: prompt.maxTokens, model },
          });
          if (tracker) tracker.inFlight = { provider: 'anthropic', key: resKey };
          let r;
          try {
            r = await llmClient.messages({ model, system: prompt.system, user: prompt.user, maxTokens: prompt.maxTokens });
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
          await settlePaidCall(deps.finops, resKey, serverLlmChargeInput({
            ownerId, itemRunId: item.itemRunId, model, messageId: r.messageId, requestId: r.requestId, usage: r.usage,
            // Llamada principal: 'main' con el intento del item (un reintento del item = otro msg_ = otra fila).
            callRole: role === 'continuation' ? 'continuation' : 'main',
            attempt: itemRole.attempt,
          }), 'anthropic_measured');
          llmMessageIds.push(r.messageId);
          if (tracker) {
            tracker.inFlight = null;
            tracker.unpersistedPaidOutput = { provider: 'anthropic', what: 'guion del audiolibro pagado sin persistir', opIds: [...llmMessageIds] };
          }
          return { text: r.text, messageId: r.messageId };
        },
      );
    } catch (err) {
      if (err instanceof LeaseLost) throw err;
      if (err instanceof BudgetBlocked) return;
      if (err instanceof AudioScriptError) return fail(deps, item, err.message, err.retryable, { knownOutcome: true });
      const e = err instanceof ProviderCallError ? err : null;
      return fail(deps, item, `audiobook_script_failed: ${err instanceof Error ? err.message : String(err)}`, e ? e.retryable : true);
    }
    script = result.script;
    scriptMeta = { words: result.words, messageIds: result.messageIds, model, continued: result.continued };
    // Idempotencia: el guion validado queda guardado — un re-claim no vuelve a pagar el LLM.
    await record(deps, item, { audiobookScript: { text: script, words: result.words, messageIds: result.messageIds, model } });
    if (tracker) tracker.unpersistedPaidOutput = null;
    // El LLM gastó: el TTS vuelve a pasar por el guard con el gasto actualizado.
    if (!(await guard(deps, item, 'openai'))) return;
  }

  const chunks = splitForTts(script);
  if (!chunks.length) await fail(deps, item, `AUDIO_SCRIPT_EMPTY: ${item.itemKey} no tiene texto para narrar`, false);
  const model = trimmed(env, 'OPENAI_TTS_MODEL') || TTS_MODEL_DEFAULT;
  const voice = trimmed(env, 'OPENAI_TTS_VOICE') || TTS_VOICE_DEFAULT;
  const tts = new OpenAiTtsClient(openaiKey, env);
  const parts: Buffer[] = [];
  const requestIds: Array<string | null> = [];
  const ttsTracker = deps.tracker;
  const paidTtsOps: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    await heartbeat(deps, item);
    const chunkIdx = i;
    // Calibración #2: reserva DURABLE del chunk antes de llamar (si falla, no se llama a OpenAI).
    const resKey = await reservePaidCall(deps.finops, {
      kind: 'tts', ownerId, itemRunId: item.itemRunId, generation: item.generation ?? 1, itemAttempt: item.attempt,
      tag: `chunk${chunkIdx}`, estimate: { characters: chunks[chunkIdx].length, model },
    });
    if (ttsTracker) ttsTracker.inFlight = { provider: 'openai', key: resKey };
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
      return fail(deps, item, `tts_failed: chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : String(err)}`, e ? e.retryable : true);
    }
    if (ttsTracker && ttsTracker.inFlight) ttsTracker.inFlight.opId = res.requestId;
    let seconds: number | null = null;
    try {
      seconds = mp3DurationSeconds(res.audio);
    } catch {
      seconds = null;
    }
    // Cargo por x-request-id (idempotente: la misma operación = un solo cargo) + reserva a 0, atómico.
    await settlePaidCall(deps.finops, resKey, ttsChargeInput({
      ownerId, itemRunId: item.itemRunId, requestId: res.requestId, audioSeconds: seconds, characters: chunks[chunkIdx].length,
      model, generation: item.generation ?? 1, chunk: chunkIdx, itemAttempt: item.attempt,
    }), 'openai_tts_measured');
    if (res.requestId) paidTtsOps.push(res.requestId);
    if (ttsTracker) {
      ttsTracker.inFlight = null;
      ttsTracker.unpersistedPaidOutput = { provider: 'openai', what: 'audio TTS pagado sin persistir', opIds: [...paidTtsOps] };
    }
    if (seconds === null) await fail(deps, item, `TTS_AUDIO_INVALID: el chunk ${i + 1}/${chunks.length} de ${item.itemKey} no es un MP3 medible`, true, { knownOutcome: true });
    requestIds.push(res.requestId);
    // Mismo transcode que tts.service (64 kbps mono; sin ffmpeg → el original, como hoy).
    parts.push(await transcodeMp3Bitrate(res.audio, TTS_TARGET_BITRATE_KBPS));
  }
  let mp3: Buffer;
  let durationSeconds: number;
  try {
    mp3 = parts.length === 1 ? parts[0] : concatMp3(parts);
    durationSeconds = mp3DurationSeconds(mp3);
  } catch (err) {
    return fail(deps, item, `TTS_AUDIO_INVALID: ${err instanceof Error ? err.message : String(err)}`, true, { knownOutcome: true });
  }
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
      model, voice, durationSeconds, chunks: chunks.length, requestIds, scriptSha256: sha256(script),
      ...(item.type === 'audiobook_chapter' ? { script, ...scriptMeta } : {}),
    },
    upsert: false,
  });
  if (ttsTracker) ttsTracker.unpersistedPaidOutput = null; // el audio pagado ya está en el Storage + artifact
  const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
    artifactIds: [row.id],
    summary: { mode: 'real', provider: 'openai', model, voice, durationSeconds, chunks: chunks.length, scriptSha256: sha256(script), ...scriptMeta },
  });
  if (!ok) deps.logger.warn(`Item ${item.itemKey}: audio subido (artifact ${row.id}) pero completeItem devolvió false (lease perdida)`);
}

/** Despacho del modo real. La lease perdida corta en silencio (otro ejecutor sigue). */
export async function processRealProviderItem(deps: RealProviderDeps, item: ClaimedItem, ownerId: string): Promise<void> {
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
      const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
        artifactIds: [prev.id],
        summary: { mode: 'real', provider: 'openai', model: m.model ?? null, voice: m.voice ?? null, durationSeconds: m.durationSeconds ?? null, chunks: m.chunks ?? null, reusedUploadedArtifact: true },
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
  // Guion del audiolibro persistido = se reutiliza sin volver a pagar el LLM.
  if (os.audiobookScript && typeof os.audiobookScript.text === 'string' && os.audiobookScript.text.trim()) skip.push('anthropic');
  const markedKey = typeof os.externalReservationKey === 'string' ? os.externalReservationKey : null;
  const { blocking, releasable } = await priorPaidOperations(deps.finops, item.itemRunId, {
    currentAttempt: item.attempt,
    acknowledgedThroughAttempt: Number(os.reconciliationAcknowledgedThroughAttempt ?? 0),
    skipProviders: skip,
    // Gamma: el marcador de envío se escribe DESPUÉS de la reserva y ANTES de llamar. Una reserva de
    // Gamma sin marcador que la nombre = la llamada nunca se hizo → se libera.
    isSubmitMarked: (key) => !key.startsWith('reservation:gamma:') || key === markedKey,
  });
  for (const r of releasable) await settlePaidCall(deps.finops, r.idempotency_key, null, 'reserved_without_submit_marker');
  if (!blocking.length) return false;
  const what = blocking.map((b) => `${b.provider} ${b.external_operation_id ?? b.idempotency_key} (intento ${b.attempt})`).join('; ');
  const msg = reconciliationMessage(
    blocking[0].provider,
    'operación pagada de un intento anterior sin resultado persistido',
    `${what}. No se llamó al proveedor en este intento.`,
  );
  deps.logger.error(`Item ${item.itemKey}: ${msg}`);
  void ownerId;
  return fail(deps, item, msg, false);
}
