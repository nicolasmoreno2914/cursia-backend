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
//
// REL MVP (2026-10-02): la política por defecto decide por la CLASE del clasificador central
// (reliability/failure-classifier.ts), no por la allow-list: A → reintento (5 rondas, 30 s…8 min
// con jitter), B de un componente de la IA del navegador → regenerar solo ese item (2 rondas), C/D →
// sin cambios. La allow-list sigue aportando las precondiciones de re-poll y la deny-list sigue ganando.
// `DYNAMIC_AUTO_HEAL_POLICY=legacy` vuelve a R16 tal cual (kill-switch).
// Puro salvo `startAutoHealTimer`.
// ─────────────────────────────────────────────────────────────────────────────
import {
  AUTO_HEAL_ALLOW_LIST,
  AUTO_HEAL_DENY_PATTERNS,
  AutoHealRule,
  SAFE_AUTO_RETRY_BACKOFF_SECONDS,
  SAFE_AUTO_RETRY_MAX_ROUNDS,
  SAFE_AUTO_RETRY_RULES,
  SafeAutoRetryRule,
} from '../reliability/auto-heal-rules';
import { isDynamicCourseStructureEnabled } from '../features/dynamic-features';
import { PROVIDER_RECONCILIATION_REQUIRED } from '../finops/run-budget';
// REL MVP: la decisión por clase usa el clasificador central (import circular seguro: solo se usa en llamadas).
import { FailureSource, classifyFailure } from '../reliability/failure-classifier';

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
  /** Rondas automáticas máximas por item de WORKER (después: humano). Clase A en la política por clase. */
  maxRounds: number;
  /** R16 fix M6: rondas máximas para items del NAVEGADOR (cada ronda repite llamadas LLM pagadas). */
  browserMaxRounds: number;
  /** R16 fix I1: solo fallos de las últimas N horas. */
  maxAgeHours: number;
  /** Espera mínima desde el fallo antes de la ronda n+1 (índice n; el último valor se repite). */
  backoffSeconds: readonly number[];
  /** Intentos que concede cada ronda (max_attempts = attempt_count + N). */
  attemptsPerRound: number;
  /**
   * REL MVP: la decisión usa el veredicto del clasificador central (A reintenta, B regenera solo el
   * componente) en vez de la allow-list R16. false = comportamiento R16 tal cual (kill-switch).
   */
  classAware?: boolean;
  /** REL MVP (clase B): rondas de regeneración por item (después: humano, D). */
  regenMaxRounds?: number;
  /** REL MVP (clase B): espera desde el fallo antes de la ronda de regeneración n+1. */
  regenBackoffSeconds?: readonly number[];
  /** REL MVP: jitter ±ratio sobre la espera (determinista por item y ronda: el barrido y el lock coinciden). */
  jitterRatio?: number;
}

/** R16 tal cual (allow-list, worker 3 / navegador 1 rondas, 2/10/30 min). `DYNAMIC_AUTO_HEAL_POLICY=legacy`. */
export const LEGACY_AUTO_HEAL_POLICY: AutoHealPolicy = Object.freeze({
  maxRounds: 3,
  browserMaxRounds: 1,
  maxAgeHours: DEFAULT_AUTO_HEAL_MAX_AGE_HOURS,
  backoffSeconds: Object.freeze([120, 600, 1800]),
  attemptsPerRound: 2,
  classAware: false,
  regenMaxRounds: 0,
  regenBackoffSeconds: Object.freeze([] as number[]),
  jitterRatio: 0,
});

/**
 * REL MVP (2026-10-02) — recuperación por clase:
 *  - A (timeouts, 5xx/524, red, lease/claim/subida, Cloudflare): hasta 5 rondas por item, espera
 *    exponencial con jitter ±20 % (30 s, 1, 2, 4, 8 min);
 *  - B (validación: banco/examen, H5P/actividad, truncado, esquema): regenera SOLO ese componente
 *    (reapertura con generación nueva de la IA), hasta 2 rondas (30 s, 2 min); después D (humano);
 *  - C/D: sin cambios (reintento seguro, reenvío único de audio, needs_attention).
 */
export const DEFAULT_AUTO_HEAL_POLICY: AutoHealPolicy = Object.freeze({
  maxRounds: 5,
  browserMaxRounds: 5,
  maxAgeHours: DEFAULT_AUTO_HEAL_MAX_AGE_HOURS,
  backoffSeconds: Object.freeze([30, 60, 120, 240, 480]),
  attemptsPerRound: 2,
  classAware: true,
  regenMaxRounds: 2,
  regenBackoffSeconds: Object.freeze([30, 120]),
  jitterRatio: 0.2,
});

export const AUTO_HEAL_POLICY_ENV = 'DYNAMIC_AUTO_HEAL_POLICY';

/** Fila mínima que evalúa la política (generation_item_runs). */
export interface AutoHealRow {
  /** Id del item (semilla del jitter). Ausente → el error. */
  id?: string | null;
  status: string;
  /** Tipo del item (tope de rondas por tipo). Ausente → tope de worker. */
  type?: string | null;
  error: string | null;
  output_summary: Record<string, any> | null;
  finished_at?: Date | string | null;
  updated_at?: Date | string | null;
  /** REL R2: clase registrada al fallar (incluye la subida por errorCode); solo sube la severidad. */
  failure_class?: string | null;
}

// REL R1: las reglas (allow/deny/SQL/reintento seguro) viven en reliability/auto-heal-rules.ts (sin cambios).
export {
  AUTO_HEAL_ALLOW_LIST,
  AUTO_HEAL_DENY_PATTERNS,
  AUTO_HEAL_SQL_ALLOW_REGEX,
  AUTO_HEAL_SQL_DENY_REGEX,
  SAFE_AUTO_RETRY_BACKOFF_SECONDS,
  SAFE_AUTO_RETRY_MAX_ROUNDS,
  SAFE_AUTO_RETRY_RULES,
  SAFE_AUTO_RETRY_SQL_REGEX,
  isProvenDefinitive4xx,
} from '../reliability/auto-heal-rules';
export type { AutoHealRule, SafeAutoRetryRule } from '../reliability/auto-heal-rules';

export type AutoHealSkipReason =
  | 'not_failed' | 'no_error' | 'denied' | 'not_allow_listed' | 'missing_precondition' | 'cap_reached' | 'backoff' | 'too_old';

/** R16 fix M6: tope de rondas según quién ejecuta el item. */
export function autoHealMaxRoundsFor(type: string | null | undefined, policy: AutoHealPolicy = DEFAULT_AUTO_HEAL_POLICY): number {
  if (type && !AUTO_HEAL_WORKER_ITEM_TYPES.includes(type)) return policy.browserMaxRounds;
  return policy.maxRounds;
}

/** REL MVP: A = reintento (misma tarea), B = regenerar solo el componente. */
export type AutoHealKind = 'A' | 'B';

export type AutoHealDecision =
  | { heal: true; rule: AutoHealRule; round: number; kind: AutoHealKind; strategy: string }
  | { heal: false; reason: AutoHealSkipReason; rule?: AutoHealRule; retryAt?: Date };

export function autoHealRoundsOf(outputSummary: Record<string, any> | null | undefined): number {
  const n = Number(outputSummary?.autoHeal?.rounds ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** REL MVP: rondas de regeneración (clase B) ya usadas por el item. */
export function autoRegenRoundsOf(outputSummary: Record<string, any> | null | undefined): number {
  const n = Number(outputSummary?.autoHeal?.regenRounds ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Motivos permanentes para ESTE texto de error (el barrido no lo vuelve a mirar hasta que el error cambie). */
export const AUTO_HEAL_PERMANENT_SKIPS: readonly AutoHealSkipReason[] = Object.freeze(['denied', 'not_allow_listed', 'missing_precondition', 'cap_reached'] as AutoHealSkipReason[]);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Espera (s) antes de la ronda `rounds + 1`, con jitter determinista ±ratio (misma semilla → mismo valor). */
export function autoHealWaitSeconds(waits: readonly number[], rounds: number, ratio: number, seed: string): number {
  const list = waits.length ? waits : [0];
  const base = list[Math.min(rounds, list.length - 1)];
  if (!(ratio > 0)) return base;
  const u = fnv1a(`${seed}:${rounds}`) / 0xffffffff;
  return base * (1 + ratio * (2 * u - 1));
}

const SEVERITY: Readonly<Record<string, number>> = Object.freeze({ A: 0, B: 1, C: 2, D: 3 });
/**
 * Fix round 1 (M1): códigos A con `paidRisk: uncertain` que SÍ se reabren solos porque el re-claim de todo
 * worker pagado verifica el ledger antes de llamar (dynamic-item-worker.ts: marcador externalSubmitStartedAt
 * → ambiguous_video_submission + priorPaidOperations; real-providers.ts priorPaidBlock: priorPaidOperations
 * → provider_reconciliation_required). Cualquier otro A incierto queda para un humano.
 */
export const AUTO_HEAL_LEDGER_GUARDED_CODES: readonly string[] = Object.freeze(['lease_expired', 'worker_draining']);
/**
 * r19 (#642): códigos B de un item de WORKER que la reapertura regenera solos (clase B, regenerate_targeted,
 * regenMaxRounds). Solo las validaciones del GUION del audiolibro: el worker las marca con resultado CONOCIDO
 * (cada llamada LLM medida y liquidada, nada en el aire) y el reintento reutiliza los guiones de bloque
 * aceptados (audiobookSections) y los segmentos TTS pagados (audioSegments): solo se vuelve a pagar la llamada
 * LLM del bloque que falló. Un TTS con resultado incierto sigue fuera (provider_reconciliation_required está en
 * la deny-list; su único reenvío automático es el de #583), y el re-claim pasa por priorPaidBlock del worker.
 */
export const AUTO_REGEN_WORKER_CODES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  audiobook_chapter: Object.freeze(['AUDIOBOOK_SECTION_PADDED', 'AUDIOBOOK_SECTION_TOO_SHORT', 'AUDIOBOOK_SCRIPT_REPETITION', 'AUDIOBOOK_SECTION_TRUNCATED']),
});
/** Estrategias B que la reapertura resuelve (regenerar el MISMO item); regenerate_dependency necesita otro item. */
const AUTO_REGEN_STRATEGIES: readonly string[] = Object.freeze(['regenerate_targeted', 'regenerate_split']);

function sourceOfType(type: string | null | undefined): FailureSource | null {
  if (!type) return null;
  if (type === 'video') return 'video_worker';
  return AUTO_HEAL_WORKER_ITEM_TYPES.includes(type) ? 'provider_worker' : 'browser_executor';
}

/** REL MVP: decisión por clase del clasificador central (ver DEFAULT_AUTO_HEAL_POLICY). Pura. */
function classAwareDecision(row: AutoHealRow, now: Date, policy: AutoHealPolicy): AutoHealDecision {
  if (row.status !== 'failed') return { heal: false, reason: 'not_failed' };
  const error = String(row.error ?? '').trim();
  if (!error) return { heal: false, reason: 'no_error' };
  if (isAutoHealDenied(error)) return { heal: false, reason: 'denied' };
  // C: los rechazos definitivos sin gasto tienen su propio barrido (un único reintento seguro).
  if (SAFE_AUTO_RETRY_RULES.some((r) => r.match.test(error))) return { heal: false, reason: 'not_allow_listed' };
  const os = (row.output_summary ?? {}) as Record<string, any>;
  const v = classifyFailure({ source: sourceOfType(row.type), itemType: row.type ?? null, error, outputSummary: os });
  if (v.unclassified) return { heal: false, reason: 'not_allow_listed' };
  let cls: string = v.class;
  const recorded = String(row.failure_class ?? '');
  if (recorded in SEVERITY && SEVERITY[recorded] > SEVERITY[cls]) cls = recorded;
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  const seed = String(row.id ?? error);
  const ratio = Math.max(0, Math.min(0.5, Number(policy.jitterRatio ?? 0)));

  if (cls === 'A') {
    // Detenido por el usuario: nunca se reabre solo.
    if (v.code === 'user_stopped') return { heal: false, reason: 'not_allow_listed' };
    // Precondición R16 (re-poll gratis solo con el id del proveedor persistido; nunca un envío nuevo).
    const legacy = matchAutoHealRule(error);
    if (legacy?.requires && !legacy.requires(os)) return { heal: false, reason: 'missing_precondition', rule: legacy };
    // Fix round 1 (M1): un A con riesgo de pago INCIERTO solo se reabre si su re-claim pasa por el chequeo del
    // ledger del worker (priorPaidOperations / marcador de envío → reconciliación, nunca un pago ciego).
    if (v.paidRisk === 'uncertain' && !AUTO_HEAL_LEDGER_GUARDED_CODES.includes(v.code)) return { heal: false, reason: 'not_allow_listed' };
    const rule: AutoHealRule = legacy ?? { code: v.code, match: /^/, why: `clase A (${v.rule})` };
    const rounds = autoHealRoundsOf(os);
    if (rounds >= autoHealMaxRoundsFor(row.type, policy)) return { heal: false, reason: 'cap_reached', rule };
    if (failedAt && now.getTime() - failedAt.getTime() > policy.maxAgeHours * 3_600_000) return { heal: false, reason: 'too_old', rule };
    if (failedAt) {
      const retryAt = new Date(failedAt.getTime() + autoHealWaitSeconds(policy.backoffSeconds, rounds, ratio, seed) * 1000);
      if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', rule, retryAt };
    }
    return { heal: true, rule, round: rounds + 1, kind: 'A', strategy: v.strategy };
  }
  if (cls === 'B') {
    // Componentes de la IA del navegador; de los items de proveedor pagado (Gamma/TTS/video) solo las validaciones
    // del GUION del audiolibro (AUTO_REGEN_WORKER_CODES): el resto sigue siendo humano.
    if (row.type && AUTO_HEAL_WORKER_ITEM_TYPES.includes(row.type)
      && !(v.class === 'B' && (AUTO_REGEN_WORKER_CODES[row.type] ?? []).includes(v.code))) {
      return { heal: false, reason: 'not_allow_listed' };
    }
    // Clase B registrada (errorCode del ejecutor que subió la severidad) sobre un mensaje A: regenerar el componente.
    const strategy = v.class === 'B' ? v.strategy : 'regenerate_targeted';
    if (!AUTO_REGEN_STRATEGIES.includes(strategy)) return { heal: false, reason: 'not_allow_listed' };
    const rule: AutoHealRule = { code: v.code, match: /^/, why: `clase B (${v.rule}): regenerar solo el componente` };
    const rounds = autoRegenRoundsOf(os);
    if (rounds >= Math.max(0, Math.floor(policy.regenMaxRounds ?? 0))) return { heal: false, reason: 'cap_reached', rule };
    if (failedAt && now.getTime() - failedAt.getTime() > policy.maxAgeHours * 3_600_000) return { heal: false, reason: 'too_old', rule };
    if (failedAt) {
      const retryAt = new Date(failedAt.getTime() + autoHealWaitSeconds(policy.regenBackoffSeconds ?? [], rounds, ratio, `${seed}:B`) * 1000);
      if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', rule, retryAt };
    }
    return { heal: true, rule, round: rounds + 1, kind: 'B', strategy };
  }
  // C / D: reglas existentes (reintento seguro, reenvío único de audio) o humano.
  return { heal: false, reason: 'not_allow_listed' };
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
  if (policy.classAware) return classAwareDecision(row, now, policy);
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
  return { heal: true, rule, round: rounds + 1, kind: 'A', strategy: 'auto_heal' };
}


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
  // REL MVP: kill-switch de la política por clase → R16 tal cual.
  const base = String(env[AUTO_HEAL_POLICY_ENV] ?? '').trim().toLowerCase() === 'legacy' ? LEGACY_AUTO_HEAL_POLICY : DEFAULT_AUTO_HEAL_POLICY;
  return { ...base, maxAgeHours };
}

/**
 * Fix round 1 (M3): recuperación automática REL MVP activa (tick encendido + política por clase). El kill-switch
 * `DYNAMIC_AUTO_HEAL_POLICY=legacy` (o el tick apagado) apaga también la reparación del empaque y el arranque
 * automático del ejecutor al abrir el curso (RunDto.autoRecovery).
 */
export function autoRecoveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return autoHealEnabled(env) && !!autoHealPolicyFromEnv(env).classAware;
}

export function autoHealIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[AUTO_HEAL_INTERVAL_ENV]);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : DEFAULT_AUTO_HEAL_INTERVAL_MS;
}

export interface AutoHealSweepResult {
  /** Filas que pasaron el filtro SQL (recencia, run vigente, allow/deny grueso, rondas, espera). */
  candidates?: number;
  reopened: Array<{ runId: string; itemKey: string; code: string; round: number; kind?: AutoHealKind; strategy?: string }>;
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
