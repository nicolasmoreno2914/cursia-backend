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
// - tope de rondas automáticas por item (autoHeal.rounds en output_summary);
// - espera creciente entre rondas, medida desde el fallo;
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

export interface AutoHealPolicy {
  /** Rondas automáticas máximas por item (después: humano). */
  maxRounds: number;
  /** Espera mínima desde el fallo antes de la ronda n+1 (índice n; el último valor se repite). */
  backoffSeconds: readonly number[];
  /** Intentos que concede cada ronda (max_attempts = attempt_count + N). */
  attemptsPerRound: number;
}

export const DEFAULT_AUTO_HEAL_POLICY: AutoHealPolicy = Object.freeze({
  maxRounds: 3,
  backoffSeconds: Object.freeze([120, 600, 1800]),
  attemptsPerRound: 2,
});

/** Fila mínima que evalúa la política (generation_item_runs). */
export interface AutoHealRow {
  status: string;
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

export type AutoHealSkipReason = 'not_failed' | 'no_error' | 'denied' | 'not_allow_listed' | 'missing_precondition' | 'cap_reached' | 'backoff';

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
  if (rounds >= policy.maxRounds) return { heal: false, reason: 'cap_reached', rule };
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  const waits = policy.backoffSeconds.length ? policy.backoffSeconds : [0];
  const waitSec = waits[Math.min(rounds, waits.length - 1)];
  if (failedAt) {
    const retryAt = new Date(failedAt.getTime() + waitSec * 1000);
    if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', rule, retryAt };
  }
  return { heal: true, rule, round: rounds + 1 };
}

export function autoHealEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (!isDynamicCourseStructureEnabled(env)) return false;
  return String(env[AUTO_HEAL_ENABLED_ENV] ?? '').trim().toLowerCase() !== 'false';
}

export function autoHealIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[AUTO_HEAL_INTERVAL_ENV]);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : DEFAULT_AUTO_HEAL_INTERVAL_MS;
}

export interface AutoHealSweepResult {
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
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  logger.log(`auto-healer de generación dinámica activo (cada ${Math.round(intervalMs / 1000)} s)`);
  return timer;
}
