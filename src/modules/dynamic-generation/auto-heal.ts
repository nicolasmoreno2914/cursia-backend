// ─────────────────────────────────────────────────────────────────────────────
// R16 (#2 + #16) — auto-healer de items `failed` por errores TRANSITORIOS.
//
// Antes, todo item que agotaba sus intentos quedaba `failed` (y sus
// dependientes `blocked`, y el run `failed`) hasta que alguien pulsara
// «Reintentar». Ahora un barrido periódico del servidor (API, ver main.ts)
// reabre —con la MISMA transacción de RunsService.retryItem, sin el
// controlador— los items cuyo último error está en una allow-list EXPLÍCITA de
// fallos transitorios (red, timeout, 5xx, lease perdido), derivada de los
// códigos que el código emite de verdad.
//
// Reglas:
// - allow-list explícita (nada fuera de ella se reabre);
// - deny-list que gana siempre: resultados pagados ambiguos / reconciliación,
//   presupuesto, cuota, configuración, permisos → nunca se reabren solos;
// - tope de rondas automáticas por item (autoHeal.rounds en output_summary):
//   3 para items de worker (re-poll gratis / sin gasto en el aire), 1 para items
//   del navegador (cada ronda repite llamadas LLM pagadas);
// - espera creciente entre rondas, medida desde el fallo: 2 min, 10 min, 30 min;
// - solo fallos RECIENTES (ventana DYNAMIC_AUTO_HEAL_MAX_AGE_HOURS, 24 h) de la
//   ejecución VIGENTE del curso (sin run más nuevo ni Manifest más nuevo): nunca
//   se revive un run viejo o abandonado; los más nuevos primero;
// - cada ronda concede AUTO_HEAL_ATTEMPTS_PER_ROUND intentos (retryItem da 3);
// - cada reapertura queda en output_summary.previousErrors (auto: true) + log.
// Ningún código de la allow-list implica un envío pagado ambiguo: o re-pollea
// un id ya persistido (gratis), o repite algo que no llegó a gastar, o (en el
// navegador) repite llamadas LLM que fallaron por red. El runtime guard de
// presupuesto sigue delante de cada llamada pagada, y la detección de gasto
// en el aire del ledger (priorPaidOperations) sigue intacta.
// Puro salvo `startAutoHealTimer`.
// ─────────────────────────────────────────────────────────────────────────────
import { BUDGET_APPROVAL_REQUIRED, BUDGET_EXCEEDED, PROVIDER_RECONCILIATION_REQUIRED } from '../finops/run-budget';
import { isDynamicCourseStructureEnabled } from '../features/dynamic-features';

export const AUTO_HEAL_ENABLED_ENV = 'DYNAMIC_AUTO_HEAL_ENABLED';
export const AUTO_HEAL_INTERVAL_ENV = 'DYNAMIC_AUTO_HEAL_INTERVAL_MS';
export const DEFAULT_AUTO_HEAL_INTERVAL_MS = 60_000;
export const AUTO_HEAL_MAX_AGE_ENV = 'DYNAMIC_AUTO_HEAL_MAX_AGE_HOURS';
/** Ventana de recencia: un fallo más viejo que esto nunca se reabre solo (run abandonado). */
export const DEFAULT_AUTO_HEAL_MAX_AGE_HOURS = 24;
/** Fix m3: rango admitido de la ventana (1 h … 7 días). */
export const AUTO_HEAL_MAX_AGE_HOURS_RANGE = Object.freeze({ min: 1, max: 168 });
/**
 * Fix m2: si retryItem rechaza un candidato (presupuesto, run reemplazado, otro
 * run activo, owner fuera de la allow-list…) el item no vuelve a evaluarse hasta
 * dentro de 30 min (autoHeal.skipUntilMs en output_summary, filtrado en SQL).
 */
export const AUTO_HEAL_SKIP_COOLDOWN_SECONDS = 1800;

/**
 * Tipos que ejecutan los workers del servidor (espejo de WORKER_ONLY_TYPES del
 * scheduler; el check lo compara). El resto los ejecuta el navegador con LLM.
 */
export const AUTO_HEAL_WORKER_ITEM_TYPES: readonly string[] = Object.freeze(['video', 'presentation', 'audio_welcome', 'audiobook_chapter']);

export interface AutoHealPolicy {
  /** Rondas automáticas máximas por item de WORKER (después: humano). */
  maxRounds: number;
  /** R16 fix M6: rondas máximas para items del NAVEGADOR (cada ronda repite llamadas LLM pagadas). */
  browserMaxRounds: number;
  /** R16 fix I1: solo fallos de las últimas N horas. */
  maxAgeHours: number;
  /** Espera mínima desde el fallo antes de la ronda n+1 (índice n; el último valor se repite). */
  backoffSeconds: readonly number[];
  /** Intentos que concede cada ronda (max_attempts = attempt_count + N). */
  attemptsPerRound: number;
}

export const DEFAULT_AUTO_HEAL_POLICY: AutoHealPolicy = Object.freeze({
  maxRounds: 3,
  browserMaxRounds: 1,
  maxAgeHours: DEFAULT_AUTO_HEAL_MAX_AGE_HOURS,
  backoffSeconds: Object.freeze([120, 600, 1800]),
  attemptsPerRound: 2,
});

/** Fila mínima que evalúa la política (generation_item_runs). */
export interface AutoHealRow {
  status: string;
  /** Tipo del item (tope de rondas por tipo). Ausente → tope de worker. */
  type?: string | null;
  error: string | null;
  output_summary: Record<string, any> | null;
  finished_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export interface AutoHealRule {
  /** Código estable (logs, previousErrors.autoHealCode). */
  code: string;
  /** El error del item cumple el patrón (anclado al inicio). */
  match: RegExp;
  /** Precondición sobre output_summary (p.ej. id del proveedor ya persistido → re-poll gratis). */
  requires?: (os: Record<string, any>) => boolean;
  /** Por qué es transitorio y sin gasto ambiguo (documentación). */
  why: string;
}

const hasGammaId = (os: Record<string, any>) => typeof os?.external?.gammaGenerationId === 'string' && os.external.gammaGenerationId !== '';
const hasVideogenJob = (os: Record<string, any>) => typeof os?.external?.videogenJobId === 'string' && os.external.videogenJobId !== '';

/**
 * Allow-list EXPLÍCITA (orden = prioridad). Fuente de cada código:
 * - lease_expired: item-transitions.sweepRunExpiredLeases.
 * - worker_draining: worker-drain (devolución ordenada en un deploy).
 * - unexpected_error: catch de dynamic-item-worker.processItem (sin envío en el aire: si lo hubo es
 *   ambiguous_video_submission) y de real-providers.processRealProviderItem (solo ANTES de una llamada
 *   pagada: con gasto en el aire es provider_reconciliation_required).
 * - content_download_failed / dependency_download_failed / <tipo>_download_failed: descarga de un
 *   artifact de dependencia (worker de video, worker de proveedores, ejecutor del navegador) antes de
 *   cualquier llamada pagada.
 * - gamma_timeout / gamma_poll_failed / gamma_export_missing / gamma_pdf_download_failed: con el
 *   generationId persistido el reintento re-pollea/re-descarga la MISMA generación (nunca reenvía).
 * - video_timeout / video_duration_unmeasured: con el job de Videogen persistido, re-poll/re-medición gratis.
 * - youtube_upload_failed: subida fallida SIN video creado (descarga del MP4, 5xx/red al iniciar); el
 *   render ya está pago y se conserva, solo se re-sube (cuota de YouTube, no dinero). La variante de cuota
 *   agotada 24 h cae en la deny-list.
 * - «❌ Falló después de N intentos»: el ejecutor del navegador agotó sus reintentos de red/429/5xx de la
 *   IA (DYN_EXHAUSTED_RETRIES_RE en 45-dynamic-generation-executor.js).
 * - «no se pudo subir el artifact …»: el Storage falló al subir la salida del navegador.
 */
export const AUTO_HEAL_ALLOW_LIST: readonly AutoHealRule[] = Object.freeze([
  { code: 'lease_expired', match: /^lease_expired\b/, why: 'el ejecutor desapareció (sueño, pestaña cerrada, reinicio); el ledger detecta un gasto en el aire al re-reclamar' },
  { code: 'worker_draining', match: /^worker_draining\b/, why: 'devolución ordenada de un worker que se reinicia, sin gasto en el aire' },
  { code: 'unexpected_error', match: /^unexpected_error\b/, why: 'error inesperado sin llamada pagada en el aire (si la hubo, el worker lo marca ambiguo/reconciliación)' },
  { code: 'download_failed', match: /^[a-z0-9_]+_download_failed\b/, why: 'descarga de un artifact/archivo (Storage/red) antes de gastar, o de un resultado ya pago' },
  { code: 'gamma_timeout', match: /^gamma_timeout\b/, requires: hasGammaId, why: 're-poll de la MISMA generación de Gamma (gratis)' },
  { code: 'gamma_poll_failed', match: /^gamma_poll_failed\b/, requires: hasGammaId, why: 're-poll de la MISMA generación de Gamma (gratis)' },
  { code: 'gamma_export_missing', match: /^gamma_export_missing\b/, requires: hasGammaId, why: 're-poll de la MISMA generación de Gamma (gratis)' },
  { code: 'video_timeout', match: /^video_timeout\b/, requires: hasVideogenJob, why: 're-poll del MISMO job de Videogen (gratis)' },
  { code: 'video_duration_unmeasured', match: /^video_duration_unmeasured\b/, requires: hasVideogenJob, why: 're-medición gratis del MISMO render' },
  {
    code: 'youtube_upload_failed',
    match: /^youtube_upload_failed\b/,
    requires: (os) => hasVideogenJob(os) && !os?.youtubeUploadStartedAt && !os?.external?.youtubeVideoId,
    why: 'subida sin video creado; el render pagado se conserva y solo se re-sube',
  },
  { code: 'browser_llm_transient', match: /^(?:❌\s*)?Fall[oó] despu[eé]s de \d+ intentos\b/i, why: 'el navegador agotó reintentos de red/429/5xx de la IA' },
  { code: 'artifact_upload_failed', match: /^no se pudo subir el artifact\b/, why: 'el Storage falló al subir la salida del navegador' },
] as AutoHealRule[]);

/**
 * Deny-list: gana SIEMPRE sobre la allow-list (aunque el mensaje empiece con
 * un código permitido). Pagos ambiguos / reconciliación, presupuesto, cuota,
 * configuración o permisos → siempre humano.
 */
export const AUTO_HEAL_DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  // Subcadena (sin \b): `_` es carácter de palabra y un prefijo como `youtube_…` escondería el código.
  new RegExp(PROVIDER_RECONCILIATION_REQUIRED, 'i'),
  new RegExp(BUDGET_EXCEEDED, 'i'),
  new RegExp(BUDGET_APPROVAL_REQUIRED, 'i'),
  /ambiguous|ambigu[oa]/i,
  /quota|cuota/i,
  /presupuesto/i,
  /not_allowed|not_configured|not_ready|provider_mode_unset|mock_not_allowed/i,
  /blocked_auth|youtube_preflight/i,
]);

export type AutoHealSkipReason =
  | 'not_failed' | 'no_error' | 'denied' | 'not_allow_listed' | 'missing_precondition' | 'cap_reached' | 'backoff' | 'too_old';

/** R16 fix M6: tope de rondas según quién ejecuta el item. */
export function autoHealMaxRoundsFor(type: string | null | undefined, policy: AutoHealPolicy = DEFAULT_AUTO_HEAL_POLICY): number {
  if (type && !AUTO_HEAL_WORKER_ITEM_TYPES.includes(type)) return policy.browserMaxRounds;
  return policy.maxRounds;
}

/**
 * R16 fix I2: filtro GRUESO en SQL (POSIX, sin \b) equivalente a la allow-list,
 * para que el LIMIT del barrido cuente solo candidatos reales. La decisión fina
 * sigue siendo autoHealDecision (JS), que se re-evalúa además bajo lock.
 */
export const AUTO_HEAL_SQL_ALLOW_REGEX =
  '^(lease_expired|worker_draining|unexpected_error|[a-z0-9_]+_download_failed|gamma_timeout|gamma_poll_failed|gamma_export_missing|' +
  'video_timeout|video_duration_unmeasured|youtube_upload_failed|no se pudo subir el artifact|(❌[[:space:]]*)?fall[oó] despu[eé]s de [0-9]+ intentos)';
/** Mismo contenido que AUTO_HEAL_DENY_PATTERNS, como una sola regex POSIX case-insensitive. */
export const AUTO_HEAL_SQL_DENY_REGEX =
  `${PROVIDER_RECONCILIATION_REQUIRED}|${BUDGET_EXCEEDED}|${BUDGET_APPROVAL_REQUIRED}|ambiguous|ambigu[oa]|quota|cuota|presupuesto|` +
  'not_allowed|not_configured|not_ready|provider_mode_unset|mock_not_allowed|blocked_auth|youtube_preflight';

export type AutoHealDecision =
  | { heal: true; rule: AutoHealRule; round: number }
  | { heal: false; reason: AutoHealSkipReason; rule?: AutoHealRule; retryAt?: Date };

export function autoHealRoundsOf(outputSummary: Record<string, any> | null | undefined): number {
  const n = Number(outputSummary?.autoHeal?.rounds ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function matchAutoHealRule(error: string): AutoHealRule | null {
  return AUTO_HEAL_ALLOW_LIST.find((r) => r.match.test(error)) ?? null;
}

export function isAutoHealDenied(error: string): boolean {
  return AUTO_HEAL_DENY_PATTERNS.some((re) => re.test(error));
}

/** Decisión pura: ¿se reabre automáticamente este item ahora? */
export function autoHealDecision(row: AutoHealRow, now: Date, policy: AutoHealPolicy = DEFAULT_AUTO_HEAL_POLICY): AutoHealDecision {
  if (row.status !== 'failed') return { heal: false, reason: 'not_failed' };
  const error = String(row.error ?? '').trim();
  if (!error) return { heal: false, reason: 'no_error' };
  if (isAutoHealDenied(error)) return { heal: false, reason: 'denied' };
  const rule = matchAutoHealRule(error);
  if (!rule) return { heal: false, reason: 'not_allow_listed' };
  const os = (row.output_summary ?? {}) as Record<string, any>;
  if (rule.requires && !rule.requires(os)) return { heal: false, reason: 'missing_precondition', rule };
  const rounds = autoHealRoundsOf(os);
  if (rounds >= autoHealMaxRoundsFor(row.type, policy)) return { heal: false, reason: 'cap_reached', rule };
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  if (failedAt && now.getTime() - failedAt.getTime() > policy.maxAgeHours * 3_600_000) return { heal: false, reason: 'too_old', rule };
  const waits = policy.backoffSeconds.length ? policy.backoffSeconds : [0];
  const waitSec = waits[Math.min(rounds, waits.length - 1)];
  if (failedAt) {
    const retryAt = new Date(failedAt.getTime() + waitSec * 1000);
    if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', rule, retryAt };
  }
  return { heal: true, rule, round: rounds + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// EV6 DoD BE-B (reglas 3–4 del usuario) — reintento automático SEGURO de un rechazo DEFINITIVO.
//
// Un llamado a un proveedor pagado cuyo resultado es INCIERTO nunca se reenvía solo
// (ambiguous_video_submission, provider_reconciliation_required, cualquier fallo después de que el
// proveedor aceptó el trabajo — incluido `videogen_failed`: no está confirmado que un render fallido
// no se cobre). Solo un fallo que el código PRUEBA como «no se creó nada / no se cobró nada» puede
// reintentarse solo, UNA vez, dentro del presupuesto ya aprobado del run (el gate de FinOps en modo
// simulación + el runtime guard del worker siguen delante; nunca se crea una aprobación nueva):
//  - `videogen_submit_rejected`: batchCreate respondió 4xx (dynamic-item-worker.ts, rama
//    isVideogenDefinitiveRejection): no hay job, la reserva se liberó ANTES de marcar el fallo. Se
//    exige además que el 4xx no sea 408/409 (mismo criterio que isDefinitiveRejection de los
//    proveedores: un timeout/conflicto del lado del proveedor no prueba que no se procesó) y que no
//    haya ningún job de Videogen registrado. El reintento archiva el marcador del envío (mismo camino
//    que resubmitVideo) — sin eso el próximo claim lo leería como envío ambiguo.
//  - `gamma_submit_failed`: createGeneration respondió 4xx definitivo (real-providers.ts): la reserva
//    se liberó y el marcador se limpió; sin generationId registrado. Reintento común (sin reenvío forzado).
// TTS (`tts_failed`) NO entra: el mismo código cubre fallos después de trozos ya cobrados (re-pagaría).
// ─────────────────────────────────────────────────────────────────────────────

export interface SafeAutoRetryRule {
  code: string;
  type: string;
  match: RegExp;
  /** El reintento debe archivar el marcador del envío (camino resubmitVideo). */
  resubmitVideo: boolean;
  requires: (os: Record<string, any>, error: string) => boolean;
  why: string;
}

/** 4xx con respuesta, salvo 408/409 (igual que isDefinitiveRejection de real-providers.ts). */
export function isProvenDefinitive4xx(error: string): boolean {
  const m = /\(HTTP (4\d\d)\)/.exec(error);
  if (!m) return false;
  const status = Number(m[1]);
  return status !== 408 && status !== 409;
}

export const SAFE_AUTO_RETRY_RULES: readonly SafeAutoRetryRule[] = Object.freeze([
  {
    code: 'videogen_submit_rejected',
    type: 'video',
    match: /^videogen_submit_rejected\b/,
    resubmitVideo: true,
    requires: (os, error) => !hasVideogenJob(os) && isProvenDefinitive4xx(error),
    why: 'Videogen rechazó el envío (4xx) sin crear job; la reserva se liberó (sin gasto)',
  },
  {
    code: 'gamma_submit_failed',
    type: 'presentation',
    match: /^gamma_submit_failed\b/,
    resubmitVideo: false,
    requires: (os) => !hasGammaId(os) && !os?.externalSubmitStartedAt,
    why: 'Gamma rechazó el envío (4xx definitivo); la reserva se liberó y el marcador se limpió (sin gasto)',
  },
] as SafeAutoRetryRule[]);

/** A lo sumo UN reintento automático por item (regla 4 del usuario). */
export const SAFE_AUTO_RETRY_MAX_ROUNDS = 1;
/** Espera desde el rechazo antes del reintento automático. */
export const SAFE_AUTO_RETRY_BACKOFF_SECONDS = 120;
/** Regex POSIX gruesa del barrido (la decisión fina es safeAutoRetryDecision). */
export const SAFE_AUTO_RETRY_SQL_REGEX = '^(videogen_submit_rejected|gamma_submit_failed)';

export function safeAutoRetryRoundsOf(outputSummary: Record<string, any> | null | undefined): number {
  const n = Number(outputSummary?.safeAutoRetry?.rounds ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export type SafeAutoRetryDecision =
  | { heal: true; rule: SafeAutoRetryRule; round: number }
  | { heal: false; reason: AutoHealSkipReason | 'declined'; rule?: SafeAutoRetryRule; retryAt?: Date };

/** Decisión pura del reintento automático seguro (una sola vez, solo rechazos probados sin gasto). */
export function safeAutoRetryDecision(row: AutoHealRow, now: Date, policy: AutoHealPolicy = DEFAULT_AUTO_HEAL_POLICY): SafeAutoRetryDecision {
  if (row.status !== 'failed') return { heal: false, reason: 'not_failed' };
  const error = String(row.error ?? '').trim();
  if (!error) return { heal: false, reason: 'no_error' };
  const rule = SAFE_AUTO_RETRY_RULES.find((r) => r.match.test(error)) ?? null;
  if (!rule || (row.type && row.type !== rule.type)) return { heal: false, reason: 'not_allow_listed' };
  // La deny-list del auto-healer también gana acá (ambiguo, cuota, presupuesto, configuración…).
  if (isAutoHealDenied(error)) return { heal: false, reason: 'denied', rule };
  const os = (row.output_summary ?? {}) as Record<string, any>;
  if (!rule.requires(os, error)) return { heal: false, reason: 'missing_precondition', rule };
  if (os.safeAutoRetry?.declined) return { heal: false, reason: 'declined', rule };
  const rounds = safeAutoRetryRoundsOf(os);
  if (rounds >= SAFE_AUTO_RETRY_MAX_ROUNDS) return { heal: false, reason: 'cap_reached', rule };
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  if (failedAt && now.getTime() - failedAt.getTime() > policy.maxAgeHours * 3_600_000) return { heal: false, reason: 'too_old', rule };
  if (failedAt) {
    const retryAt = new Date(failedAt.getTime() + SAFE_AUTO_RETRY_BACKOFF_SECONDS * 1000);
    if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', rule, retryAt };
  }
  return { heal: true, rule, round: rounds + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// #583 (decisión del usuario 2026-10-02) — UN reenvío automático de un AUDIO con resultado incierto.
//
// La validación #583 necesitó un admin para un capítulo del audiolibro cuyo TTS se cortó tras enviarse
// (`provider_reconciliation_required: openai …`, ≈ USD 0.02). Regla aprobada:
//  - solo items de audio (audio_welcome / audiobook_chapter) cuya operación incierta es de OpenAI TTS
//    (el guion LLM del audiolibro —anthropic— sigue siendo de admin); VIDEO nunca (regla de siempre);
//  - solo si el costo estimado del reenvío es chico: lo pendiente sin liquidar de ese item (las reservas
//    de la operación incierta = lo que cuesta repetirla) ≤ AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD;
//  - UNA vez por item, marcado en output_summary.ambiguousAudioResubmit (bajo lock, misma escritura que
//    la reapertura: sobrevive ticks y reinicios). Si vuelve a quedar incierto → nunca más automático:
//    admin (adminActions + needs_attention);
//  - FinOps: la reserva pendiente de la operación incierta QUEDA registrada (cuenta como gasto, igual que
//    el «Resolver cobro» humano); el reenvío reserva lo suyo dentro del presupuesto YA autorizado del run
//    (gate en simulación al reabrir + runtime guard del worker antes de llamar); nunca crea aprobaciones.
// ─────────────────────────────────────────────────────────────────────────────

export const AMBIGUOUS_AUDIO_RESUBMIT_TYPES: readonly string[] = Object.freeze(['audio_welcome', 'audiobook_chapter']);
/** Tope de costo estimado por reenvío automático (USD). Más que esto → admin. */
export const AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD = 0.1;
/** A lo sumo UN reenvío automático por item. */
export const AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS = 1;
/** Espera desde el fallo incierto antes del reenvío automático. */
export const AMBIGUOUS_AUDIO_RESUBMIT_BACKOFF_SECONDS = 120;
export const AMBIGUOUS_AUDIO_RESUBMIT_CODE = 'ambiguous_audio_resubmit';
/** Regex POSIX gruesa del barrido (la decisión fina es ambiguousAudioResubmitDecision). */
export const AMBIGUOUS_AUDIO_RESUBMIT_SQL_REGEX = `^${PROVIDER_RECONCILIATION_REQUIRED}: openai([^a-z0-9_]|$)`;
const AMBIGUOUS_AUDIO_RESUBMIT_RE = new RegExp(`^${PROVIDER_RECONCILIATION_REQUIRED}: openai(?![a-z0-9_])`);
/** La deny-list del auto-healer SIN las dos entradas que describen justamente este caso (incierto/conciliación). */
const AMBIGUOUS_AUDIO_DENY: readonly RegExp[] = Object.freeze(
  AUTO_HEAL_DENY_PATTERNS.filter((re) => !re.test(PROVIDER_RECONCILIATION_REQUIRED) && !re.test('ambiguous')),
);

export function ambiguousAudioResubmitRoundsOf(outputSummary: Record<string, any> | null | undefined): number {
  const n = Number(outputSummary?.ambiguousAudioResubmit?.rounds ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Lo pendiente (sin liquidar) del item en el ledger, por proveedor. null = no se consultó. */
export interface AmbiguousAudioPending {
  /** Suma de las reservas sin liquidar de intentos no reconocidos (USD). */
  pendingUsd: number;
  /** Proveedores de esas reservas. */
  providers: string[];
}

export type AmbiguousAudioDecision =
  | { heal: true; round: number; pendingUsd: number | null }
  | { heal: false; reason: AutoHealSkipReason | 'declined' | 'over_threshold' | 'not_audio'; retryAt?: Date; pendingUsd?: number | null };

/**
 * Decisión pura. `pending` undefined = el llamador no consultó el ledger (completion: solo decide si
 * el servidor todavía lo va a resolver solo); el barrido y retryItem SIEMPRE lo pasan.
 */
export function ambiguousAudioResubmitDecision(
  row: AutoHealRow,
  now: Date,
  pending?: AmbiguousAudioPending | null,
  policy: AutoHealPolicy = DEFAULT_AUTO_HEAL_POLICY,
  maxUsd: number = AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD,
): AmbiguousAudioDecision {
  if (row.status !== 'failed') return { heal: false, reason: 'not_failed' };
  if (!row.type || !AMBIGUOUS_AUDIO_RESUBMIT_TYPES.includes(row.type)) return { heal: false, reason: 'not_audio' };
  const error = String(row.error ?? '').trim();
  if (!error) return { heal: false, reason: 'no_error' };
  if (!AMBIGUOUS_AUDIO_RESUBMIT_RE.test(error)) return { heal: false, reason: 'not_allow_listed' };
  if (AMBIGUOUS_AUDIO_DENY.some((re) => re.test(error))) return { heal: false, reason: 'denied' };
  const os = (row.output_summary ?? {}) as Record<string, any>;
  if (os.ambiguousAudioResubmit?.declined) return { heal: false, reason: 'declined' };
  const rounds = ambiguousAudioResubmitRoundsOf(os);
  if (rounds >= AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS) return { heal: false, reason: 'cap_reached' };
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  if (failedAt && now.getTime() - failedAt.getTime() > policy.maxAgeHours * 3_600_000) return { heal: false, reason: 'too_old' };
  let pendingUsd: number | null = null;
  if (pending !== undefined) {
    // Sin nada pendiente, o con algo pendiente de OTRO proveedor (p.ej. el guion LLM): no es este caso.
    if (!pending || !(pending.pendingUsd > 0) || pending.providers.length === 0 || pending.providers.some((p) => p !== 'openai')) {
      return { heal: false, reason: 'missing_precondition', pendingUsd: pending ? pending.pendingUsd : null };
    }
    pendingUsd = pending.pendingUsd;
    if (pendingUsd > maxUsd) return { heal: false, reason: 'over_threshold', pendingUsd };
  }
  if (failedAt) {
    const retryAt = new Date(failedAt.getTime() + AMBIGUOUS_AUDIO_RESUBMIT_BACKOFF_SECONDS * 1000);
    if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', retryAt, pendingUsd };
  }
  return { heal: true, round: rounds + 1, pendingUsd };
}

export function autoHealEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (!isDynamicCourseStructureEnabled(env)) return false;
  return String(env[AUTO_HEAL_ENABLED_ENV] ?? '').trim().toLowerCase() !== 'false';
}

/** Política efectiva (ventana de recencia configurable por env). */
export function autoHealPolicyFromEnv(env: Record<string, string | undefined> = process.env): AutoHealPolicy {
  const raw = Number(env[AUTO_HEAL_MAX_AGE_ENV]);
  const { min, max } = AUTO_HEAL_MAX_AGE_HOURS_RANGE;
  const maxAgeHours = Number.isFinite(raw) && raw > 0 ? Math.min(max, Math.max(min, raw)) : DEFAULT_AUTO_HEAL_MAX_AGE_HOURS;
  return { ...DEFAULT_AUTO_HEAL_POLICY, maxAgeHours };
}

export function autoHealIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[AUTO_HEAL_INTERVAL_ENV]);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : DEFAULT_AUTO_HEAL_INTERVAL_MS;
}

export interface AutoHealSweepResult {
  /** Filas que pasaron el filtro SQL (recencia, run vigente, allow/deny grueso, rondas, espera). */
  candidates?: number;
  reopened: Array<{ runId: string; itemKey: string; code: string; round: number }>;
  skipped: Array<{ runId: string; itemKey: string; reason: string }>;
}

interface TimerLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * Timer del barrido (solo el proceso de la API lo arranca, ver main.ts: los
 * workers cargan el mismo AppModule y no deben barrer). Sin solapamiento: si
 * un barrido sigue en curso, el tick se salta. null si está apagado.
 */
export function startAutoHealTimer(
  runs: { autoHealFailedItems(): Promise<AutoHealSweepResult> },
  logger: TimerLogger,
  env: Record<string, string | undefined> = process.env,
  /**
   * EV6 DoD BE-B: barridos extra del MISMO tick (reintento automático seguro, empaque automático
   * pendiente). Corren después del auto-healer, en serie; un error de uno no frena a los demás.
   */
  extraSweeps: ReadonlyArray<{ name: string; run: () => Promise<unknown> }> = [],
): NodeJS.Timeout | null {
  if (!autoHealEnabled(env)) {
    logger.log(`auto-healer de generación dinámica apagado (${AUTO_HEAL_ENABLED_ENV}=false o flag dinámico apagado)`);
    return null;
  }
  const intervalMs = autoHealIntervalMs(env);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runs
      .autoHealFailedItems()
      .catch((err) => logger.warn(`auto-healer: el barrido falló (${err instanceof Error ? err.message : String(err)}); se reintenta en el próximo tick`))
      .then(async () => {
        for (const x of extraSweeps) {
          try {
            await x.run();
          } catch (err) {
            logger.warn(`${x.name}: el barrido falló (${err instanceof Error ? err.message : String(err)}); se reintenta en el próximo tick`);
          }
        }
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  logger.log(`auto-healer de generación dinámica activo (cada ${Math.round(intervalMs / 1000)} s)`);
  return timer;
}
