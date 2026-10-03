// ─────────────────────────────────────────────────────────────────────────────
// REL R1 — reglas del auto-healer (R16) y del reintento automático seguro (EV6 DoD BE-B) como DATOS
// del módulo de confiabilidad. Movidas TAL CUAL desde dynamic-generation/auto-heal.ts (paso que
// preserva el comportamiento): auto-heal.ts las re-exporta y sus decisiones no cambian. El
// clasificador central (failure-classifier.ts) las consulta para informar qué haría HOY el healer
// con cada fallo (`currentRecovery`), sin actuar todavía (eso es R3).
// ─────────────────────────────────────────────────────────────────────────────
import { BUDGET_APPROVAL_REQUIRED, BUDGET_EXCEEDED, PROVIDER_RECONCILIATION_REQUIRED } from '../finops/run-budget';

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

export const hasGammaId = (os: Record<string, any>) => typeof os?.external?.gammaGenerationId === 'string' && os.external.gammaGenerationId !== '';
export const hasVideogenJob = (os: Record<string, any>) => typeof os?.external?.videogenJobId === 'string' && os.external.videogenJobId !== '';

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
