// ─────────────────────────────────────────────────────────────────────────────
// REL R1 — clasificador CENTRAL de fallos (diseño REL §3). Único lugar que decide la clase
// (A recuperable / B regenerable / C pago incierto / D irrecuperable) y la estrategia de
// recuperación de un fallo de item, de paquete o de restauración.
//
// Estado en R1/R2: la clasificación se REGISTRA y se EXPONE (generation_item_runs.failure_*,
// generation_item_attempts, RunDto.items[].recovery), pero NO se actúa sobre ella: el auto-healer
// (R16) y el reintento automático seguro (EV6 DoD BE-B) siguen decidiendo exactamente como antes
// con sus propias reglas (reliability/auto-heal-rules.ts). `currentRecovery` informa qué hace HOY
// el sistema con cada fallo; `targetRounds`/`strategy` describen la política objetivo de R3.
//
// Reglas (diseño §3.1, fix round 1):
// - el código sale del MENSAJE (hecho del servidor: prefijo `codigo:` / `CODIGO:`, el envoltorio
//   «❌ Falló después de N intentos», frases estables del ejecutor del navegador, o — SOLO para
//   llamadas HTTP de la IA — el status HTTP);
// - un `errorCode` del ejecutor NO es de confianza (C1): solo puede SUBIR la severidad
//   (A < B < C < D, y el riesgo de pago), nunca bajarla ni pisar un hecho del servidor (envío pagado,
//   reconciliación, presupuesto, códigos propios de los workers). Del navegador solo se aceptan
//   códigos que el navegador puede producir; el resto se registra como reportado y se ignora;
// - código desconocido → clase D `hold_for_human` (`unclassified: true`, alerta de ingeniería):
//   desconocido nunca es A (I4);
// - fallos de cuota/crédito/autenticación/facturación de un proveedor → D-config a scope PROVIDER
//   (`wait_provider`): pausan los items de ese proveedor sin quemar intentos (I1);
// - la tabla cubre TODOS los códigos que el backend/workers/ejecutor emiten hoy:
//   scripts/check-rel-failure-classes.js escanea los emisores y falla ante un código nuevo sin
//   regla explícita.
// Puro (sin I/O).
// ─────────────────────────────────────────────────────────────────────────────
import type { RunAdminActionCode } from '../dynamic-generation/run-completion';
import {
  AUTO_HEAL_DENY_PATTERNS,
  SAFE_AUTO_RETRY_RULES,
} from './auto-heal-rules';
// #583 (decisión del usuario A, 2026-10-02): UN reenvío automático de un audio TTS incierto si lo pendiente
// del item en el ledger es ≤ USD 0.10. La decisión (con el ledger, bajo lock) vive en auto-heal.ts; acá se usa
// la misma función pura SIN ledger para informar qué hace hoy el sistema.
import { ambiguousAudioResubmitDecision, autoHealDecision, autoHealPolicyFromEnv } from '../dynamic-generation/auto-heal';

export type FailureClass = 'A' | 'B' | 'C' | 'D';
export const FAILURE_CLASSES: readonly FailureClass[] = Object.freeze(['A', 'B', 'C', 'D']);

export type Strategy =
  | 'retry_backoff' // A: la misma tarea otra vez, backoff exponencial + jitter
  | 'repoll_external' // A: re-pollear / re-descargar un id del proveedor ya persistido (gratis)
  | 'wait_provider' // A (scope provider): esperar al proveedor (cuota, breaker); no consume intento
  | 'regenerate_targeted' // B: regenerar SOLO este componente (prompt de reparación / borrador por hoja)
  | 'regenerate_split' // B: regenerar con una pista de recuperación (llamadas más chicas / partes)
  | 'regenerate_dependency' // B: el artifact de entrada está corrupto → regenerar el item productor
  | 'provider_check' // C: consultar al proveedor (lookup por id / referencia) y re-clasificar
  | 'auto_resubmit_once' // C: un reenvío acotado permitido por regla del usuario (TTS)
  | 'hold_for_human' // C/D: needs_attention con una acción de admin
  | 'repackage'
  | 'repair_package'
  | 'reverify';
export const STRATEGIES: readonly Strategy[] = Object.freeze([
  'retry_backoff', 'repoll_external', 'wait_provider', 'regenerate_targeted', 'regenerate_split', 'regenerate_dependency',
  'provider_check', 'auto_resubmit_once', 'hold_for_human', 'repackage', 'repair_package', 'reverify',
] as Strategy[]);

export type Scope = 'item' | 'provider' | 'run' | 'package';
export type PaidRisk = 'none' | 'measured' | 'uncertain';
export type HumanReason = 'budget' | 'config' | 'duplicate_charge' | 'unrecoverable' | 'product_bug';
export const HUMAN_REASONS: readonly HumanReason[] = Object.freeze(['budget', 'config', 'duplicate_charge', 'unrecoverable', 'product_bug'] as HumanReason[]);

export type FailureSource =
  | 'browser_executor' | 'server_executor' | 'llm_gateway' | 'video_worker' | 'provider_worker'
  | 'scheduler' | 'package_worker' | 'restore_worker';

export type FailureProvider = 'anthropic' | 'openai' | 'gamma' | 'videogen' | 'youtube' | 'storage' | 'finops';

export interface FailureInput {
  source?: FailureSource | null;
  itemType?: string | null;
  /** Código explícito del emisor (FailItemDto.errorCode). Gana si es conocido. */
  errorCode?: string | null;
  error: string;
  httpStatus?: number | null;
  provider?: FailureProvider | null;
  outputSummary?: Record<string, any> | null;
}

/** Qué hace HOY el sistema con este fallo (antes de R3): reglas de auto-heal.ts sin cambios. */
export type CurrentRecovery =
  | 'executor_retry' // retryable en el item (attempt_count < max_attempts): el scheduler lo reintenta
  | 'auto_heal' // allow-list del auto-healer (R16)
  | 'safe_auto_retry' // reintento automático seguro (EV6 DoD BE-B)
  | 'ambiguous_audio_resubmit' // #583: UN reenvío automático de audio TTS incierto (≤ USD 0.10 pendiente, lo decide auto-heal con el ledger)
  | 'auto_regenerate' // REL MVP: clase B de un componente de la IA → el auto-healer lo regenera solo (≤ 2 rondas)
  | 'provider_probe' // REL CREDIT: crédito/cuota agotados → sonda del proveedor (canario) y reanudación sola (solo en la vista)
  | 'denied' // deny-list: nunca se reabre solo
  | 'manual'; // nada automático: humano (retry/regenerate)

export interface FailureVerdict {
  class: FailureClass;
  /** Código estable (≤ 64). */
  code: string;
  strategy: Strategy;
  scope: Scope;
  paidRisk: PaidRisk;
  /** Rondas automáticas objetivo de la política (R3). 0 = ninguna. */
  targetRounds: number;
  /** Proveedor afectado (breakers de R3). */
  provider?: FailureProvider | null;
  retryAfterSeconds?: number | null;
  adminAction?: RunAdminActionCode | null;
  humanReason?: HumanReason | null;
  /** Id de la regla que decidió (auditoría / check). */
  rule: string;
  /** true = ninguna regla explícita: A ×1 → D `unclassified_error` + alerta de ingeniería. */
  unclassified: boolean;
  /** Códigos internos del validador (v3_payload_invalid [..], presentation_artifact_invalid: ..). */
  innerCodes?: string[];
  /** Status HTTP detectado en el mensaje (IA / proveedor), si lo hay. */
  httpStatus?: number | null;
  /** C1: errorCode que reportó el ejecutor (no de confianza), si lo hubo. */
  reportedCode?: string | null;
  /** C1: true si el errorCode reportado se ignoró (no lo puede producir esa fuente, o no subía la severidad). */
  reportedCodeIgnored?: boolean;
  /** N2: el piso de dinero (deny-list) subió el veredicto a C. */
  moneyFloor?: boolean;
  /** N5: el proveedor reportó cuota/crédito/auth (contexto que se conserva aunque la clase sea C). */
  providerConfigIssue?: boolean;
  /** N5: unidades ya pagadas de este intento (p.ej. trozos de TTS antes del que falló); un reenvío las pagaría otra vez. */
  paidUnits?: number;
}

/** Longitud máxima de un código estable (columna failure_code). */
export const FAILURE_CODE_MAX = 64;
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function isValidFailureCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_RE.test(code);
}

// ─── Tabla ───────────────────────────────────────────────────────────────────

interface Rule {
  id: string;
  /** Códigos exactos. */
  codes?: readonly string[];
  /** Familia (regex sobre el código). */
  family?: RegExp;
  class: FailureClass;
  strategy: Strategy;
  scope?: Scope;
  paidRisk?: PaidRisk;
  rounds: number;
  provider?: FailureProvider;
  adminAction?: RunAdminActionCode;
  humanReason?: HumanReason;
  /** Variante por mensaje/contexto: devuelve un parche del veredicto o null (se usa la base). */
  refine?: (ctx: RefineCtx) => Partial<Rule> | null;
}

interface RefineCtx {
  code: string;
  error: string;
  httpStatus: number | null;
  outputSummary: Record<string, any>;
  itemType: string | null;
}

const hasGammaId = (os: Record<string, any>) => typeof os?.external?.gammaGenerationId === 'string' && os.external.gammaGenerationId !== '';
const hasVideogenJob = (os: Record<string, any>) => typeof os?.external?.videogenJobId === 'string' && os.external.videogenJobId !== '';

/**
 * Motivos de guard del scheduler (ItemOpResult.reason): NO son fallos del item — el ejecutor
 * abandona y no hay cambio de estado (diseño §3.2, fila «guard reasons»). Nunca llegan a
 * applyItemFailure; se listan para que el check sepa que existen.
 */
export const GUARD_REASON_CODES: readonly string[] = Object.freeze([
  'lease_lost', 'not_running', 'run_cancelled', 'run_not_active', 'superseded_run', 'generation_changed', 'item_not_completed',
  'not_found', 'no_artifacts', 'invalid_artifact_id', 'invalid_summary', 'invalid_patch', 'external_conflict',
  'artifact_changed_after_validation',
]);

/**
 * Códigos internos de validación (dentro de `v3_payload_invalid [..]`, del ejecutor y de los validadores
 * de banco/H5P/GIFT). Todos son de clase B (salida de la IA inválida → regenerar solo el componente).
 */
export const VALIDATION_INNER_CODES: readonly string[] = Object.freeze([
  // course-shell / visual-components / intro-schemas / final-exam / activity-type
  'ACTIVITY_TYPE_MISMATCH', 'ACTIVITY_TYPE_RULES', 'ACTIVITY_TYPE_UNKNOWN', 'ANSWER_LEAK', 'ARITY_MISMATCH', 'CHAPTER_ID',
  'CHAPTER_ID_MISMATCH', 'COMPONENT_NOT_ALLOWED', 'COUNT_RANGE', 'DIGIT_IN_TEXT', 'EDU_FIELDS_MISSING', 'ENUM_VALUE',
  'EXPLANATIONS_GATE', 'FORBIDDEN_CLAIM', 'HTML_IN_TEXT', 'ITEM_KEY_MISMATCH', 'JOURNEY_MISMATCH', 'JSON_INVALID',
  'MISSING_FIELD', 'MOVEMENT_RANGE', 'NOT_OBJECT', 'PEDAGOGY_MISSING', 'QUANTITY_CLAIM', 'QUIZ_RANDOM', 'RESOURCE_MENTION',
  'SCHEMA_VERSION', 'TEXT_DENSE', 'TEXT_EMPTY', 'TEXT_FORMAT', 'TEXT_SIMULATED_DIAGRAM', 'TEXT_TOO_LONG', 'TYPE_DIVERSITY',
  'TYPE_MISMATCH', 'TYPE_REPEATED', 'UNKNOWN_COMPONENT', 'UNKNOWN_FIELD', 'URL_IN_TEXT', 'VIDEO_DURATION_MISSING',
  'VIDEO_YOUTUBE_ID_MISSING', 'WORD_RANGE', 'FABRICATED_DATA', 'REAL_LABEL', 'OUTDATED_CLAIM', 'FOREIGN_LAW',
  'GRAMMAR_PERSON', 'ANSWER_LENGTH_BIAS', 'TF_BALANCE', 'H5P_INPUT_INVALID', 'H5P_TYPE_NOT_GRADABLE',
  'VIDEO_TOO_SHORT_FOR_INTERACTIONS', 'VIDEO_PLAN_INVARIANT', 'VIDEO_DURATION_INVALID', 'EXAM_ARTIFACT_AMBIGUOUS',
  'GIFT_EMPTY', 'GIFT_EMPTY_QUESTION', 'GIFT_NO_QUESTIONS', 'GIFT_QUESTION_COUNT', 'GIFT_UNPARSEABLE_BLOCK',
  'EXAM_NEUROMYTH', 'PRESENTATION_CARD_SLIDE_COUNT', 'SLIDE_COUNT',
]);
/** Familias de códigos internos de validación (clase B). */
export const VALIDATION_INNER_FAMILIES: readonly RegExp[] = Object.freeze([
  /^TEXT_[A-Z0-9_]+$/, /^BS_[A-Z0-9_]+$/, /^DIAGRAM_[A-Z0-9_]+$/, /^CONTENT_TRUTH[A-Z0-9_]*$/, /^EXAM_BANK_[A-Z0-9_]+$/,
  /^GIFT_[A-Z0-9_]+$/, /^PDF_[A-Z0-9_]+$/, /^COVER_[A-Z0-9_]+$/, /^PNG_[A-Z0-9_]+$/, /^H5P_[A-Z0-9_]+_INVALID$/,
]);

export function isKnownValidationCode(code: string): boolean {
  return VALIDATION_INNER_CODES.includes(code) || VALIDATION_INNER_FAMILIES.some((re) => re.test(code));
}

/** Items que ejecutan los workers contra proveedores pagados. */
const WORKER_ITEM_TYPES = new Set(['video', 'presentation', 'audio_welcome', 'audiobook_chapter']);

/**
 * I1: cuota / crédito / facturación / autenticación de un PROVEEDOR (cuerpos reales de provider-clients.ts:
 * `HTTP 429: …insufficient_quota…`, `HTTP 400: credit balance is too low`, `HTTP 401/402/403`). Un 429 SIN
 * palabras de cuota es un transitorio (A con backoff), no esto.
 */
export const PROVIDER_CONFIG_RE =
  /insufficient_quota|exceeded your current quota|\bquota\b|\bcuota\b|\bsaldo\b|\bcredits?\b|cr[eé]ditos?\b|\bbalance\b|billing|facturaci[oó]n|payment required|\bHTTP 40[123]\b|\b40[123] (?:Unauthorized|Payment Required|Forbidden)\b|invalid[_ ]api[_ ]key|unauthori[sz]ed|forbidden/i;

/** Reglas de LLAMADAS a un proveedor pagado: a ellas se aplica el chequeo de configuración del proveedor (I1). */
const PROVIDER_CALL_RULES: Readonly<Record<string, FailureProvider | null>> = Object.freeze({
  tts_failed: 'openai',
  audiobook_script_failed: 'anthropic',
  gamma_submit_failed: 'gamma',
  gamma_repoll: 'gamma',
  videogen_submit_rejected: 'videogen',
  video_repoll: 'videogen',
  llm_transient: 'anthropic',
  // unexpected_error: el catch de los workers antes de una llamada pagada puede traer el cuerpo de un proveedor.
  unexpected_error: null,
} as Record<string, FailureProvider | null>);

/** Ids de reglas a las que se aplica el chequeo de configuración del proveedor (check). */
export const PROVIDER_CALL_RULE_IDS: readonly string[] = Object.freeze(Object.keys(PROVIDER_CALL_RULES));

/** N5: trozos de TTS ya pagados antes del que falló («chunk N/M» → N-1). */
function ttsPaidChunks(error: string): number {
  const m = /chunk (\d+)\/(\d+)/.exec(error);
  return m ? Math.max(0, Number(m[1]) - 1) : 0;
}

/** N3: proveedor por el código mismo (prefijos videogen, gamma o GAMMA, openai_tts, youtube). */
function providerFromCode(code: string): FailureProvider | null {
  if (/^(videogen|video_|real_video|ambiguous_video)/i.test(code)) return 'videogen';
  if (/^gamma|^GAMMA_|^theme_resolution/i.test(code)) return 'gamma';
  if (/^openai|^tts|^insufficient_quota/i.test(code)) return 'openai';
  if (/youtube|^blocked_(auth|quota)|^reauth|^channel_unresolved|^needs_youtube|^wait_quota|^oauth/i.test(code)) return 'youtube';
  return null;
}

/** N3: proveedor por tipo de item cuando el mensaje no lo nombra. */
function providerFromItemType(itemType: string | null): FailureProvider | null {
  if (itemType === 'video') return 'videogen';
  if (itemType === 'presentation') return 'gamma';
  if (itemType === 'audio_welcome' || itemType === 'audiobook_chapter') return 'openai';
  return null;
}

function providerFromMessage(error: string): FailureProvider | null {
  const m = /\b(openai|anthropic|gamma|videogen|youtube)\b/i.exec(error);
  return m ? (m[1].toLowerCase() as FailureProvider) : null;
}

const ITEM_RULES: readonly Rule[] = Object.freeze([
  // ── Infraestructura, lease y transporte ────────────────────────────────────
  {
    // M1: un lease puede vencer A MITAD de una llamada pagada de un worker → riesgo incierto (el ledger
    // re-verifica al re-reclamar); en items LLM del navegador el gasto queda medido por el proxy.
    id: 'lease_expired', codes: ['lease_expired'], class: 'A', strategy: 'retry_backoff', paidRisk: 'measured', rounds: 3,
    refine: ({ itemType }) => (itemType && WORKER_ITEM_TYPES.has(itemType) ? { paidRisk: 'uncertain' } : null),
  },
  { id: 'worker_draining', codes: ['worker_draining'], class: 'A', strategy: 'retry_backoff', rounds: 3 },
  { id: 'unexpected_error', codes: ['unexpected_error'], class: 'A', strategy: 'retry_backoff', rounds: 3 },
  { id: 'unknown_error', codes: ['unknown_error'], class: 'A', strategy: 'retry_backoff', rounds: 1 },
  {
    id: 'download_failed',
    codes: ['download_failed', 'text_fetch_failed', 'download_url_failed', 'sign_failed', 'storage_unavailable'],
    family: /^[a-z0-9_]+_download_failed$/,
    class: 'A', strategy: 'retry_backoff', provider: 'storage', rounds: 3,
  },
  {
    // Variante de descarga (A) vs. de contrato (D: el capítulo llegó con ≠ 1 artifacts).
    id: 'exam_bank_chapter_md_missing', codes: ['EXAM_BANK_CHAPTER_MD_MISSING'], class: 'A', strategy: 'retry_backoff', provider: 'storage', rounds: 3,
    refine: ({ error }) => (/llegó con \d+ artifacts|se esperaba 1/.test(error)
      ? { class: 'D', strategy: 'hold_for_human', rounds: 0, humanReason: 'product_bug', adminAction: 'regenerate_item', provider: undefined }
      : null),
  },
  { id: 'artifact_upload_failed', codes: ['artifact_upload_failed', 'upload_failed'], class: 'A', strategy: 'retry_backoff', provider: 'storage', rounds: 3 },
  { id: 'complete_rejected', codes: ['complete_rejected'], class: 'A', strategy: 'retry_backoff', rounds: 1 },
  { id: 'finops_unavailable', codes: ['finops_unavailable', 'finops_ledger_write_failed'], class: 'A', strategy: 'wait_provider', scope: 'run', provider: 'finops', rounds: 3 },
  { id: 'browser_auth', codes: ['token_refresh_failed', 'browser_auth', 'browser_session_missing'], class: 'A', strategy: 'retry_backoff', rounds: 3 },
  { id: 'user_stopped', codes: ['user_stopped'], class: 'A', strategy: 'retry_backoff', rounds: 1 },

  // ── IA (Anthropic; proxy del navegador o gateway del servidor) ─────────────
  // N6 (restricción de diseño para R3): un veredicto de auth/crédito/proveedor de Anthropic REPORTADO por el navegador
  // (mensajes del proxy, `Sin disponibilidad…`, errorCode llm_auth_rejected/llm_credit_exhausted) nunca puede abrir un
  // breaker GLOBAL de `anthropic`: solo uno por dueño, salvo corroboración del proxy/gateway del servidor.
  // cursia#68 (SSE): `llm_stream_cut` = el stream de la IA se cortó / dejó de responder / quedó incompleto. Transitorio
  // (A, reintento); el gasto ya queda en el ledger con el cargo conservador del proxy (paidRisk measured, sin más riesgo).
  { id: 'llm_transient', codes: ['browser_llm_transient', 'llm_transient', 'llm_empty_response', 'llm_network', 'llm_stream_cut'], class: 'A', strategy: 'retry_backoff', paidRisk: 'measured', provider: 'anthropic', rounds: 3 },
  {
    id: 'llm_config',
    codes: ['llm_credit_exhausted', 'llm_auth_rejected', 'proxy_misconfigured', 'llm_model_config', 'llm_model_not_allowed', 'llm_api_key_missing', 'llm_model_missing'],
    class: 'D', strategy: 'wait_provider', scope: 'provider', provider: 'anthropic', rounds: 0, humanReason: 'config',
  },
  {
    // 400 de la IA sin otra pista: si es por tamaño → B split; si no, D (bug de producto: el mismo pedido vuelve a fallar).
    id: 'llm_request_rejected', codes: ['llm_request_rejected'], class: 'D', strategy: 'hold_for_human', provider: 'anthropic', rounds: 0, humanReason: 'product_bug', adminAction: 'retry_item',
    refine: ({ error }) => (/too long|demasiado grande|prompt is too long|max_tokens|context/i.test(error)
      ? { class: 'B', strategy: 'regenerate_split', rounds: 2, humanReason: undefined, adminAction: undefined }
      : null),
  },
  { id: 'llm_too_large', codes: ['llm_request_too_large', 'EXAM_BANK_PROMPT_TOO_LARGE'], class: 'B', strategy: 'regenerate_split', provider: 'anthropic', rounds: 2 },
  {
    id: 'output_truncated',
    codes: ['OUTPUT_TRUNCATED_MAX_TOKENS', 'CONTENT_TRUNCATED_MAX_TOKENS', 'CONTENT_TRUNCATED', 'llm_output_truncated'],
    class: 'B', strategy: 'regenerate_split', rounds: 2,
  },
  { id: 'budget', codes: ['budget_exceeded', 'budget_approval_required', 'budget_blocked'], class: 'D', strategy: 'hold_for_human', scope: 'run', rounds: 0, humanReason: 'budget', adminAction: 'approve_budget' },

  // ── Validación (B: regenerar solo el componente) ───────────────────────────
  { id: 'v3_payload_invalid', codes: ['v3_payload_invalid'], class: 'B', strategy: 'regenerate_targeted', rounds: 2 },
  {
    id: 'validation_invalid',
    codes: ['validation_invalid', 'content_empty', 'gift_invalid', 'llm_output_invalid', 'scorm_invalid', 'concept_plan_invalid',
      'CONTENT_TRUTH', 'CONTENT_TRUTH_RETRY_INVALID', 'EXAM_NEUROMYTH', 'AUDIOBOOK_SCRIPT_TOO_SHORT'],
    family: /^(GIFT|BS|TEXT|DIAGRAM)_[A-Z0-9_]+$/,
    class: 'B', strategy: 'regenerate_targeted', rounds: 2,
  },
  {
    id: 'exam_bank_invalid',
    family: /^EXAM_BANK_[A-Z0-9_]+$/,
    class: 'B', strategy: 'regenerate_targeted', rounds: 2,
    // EXAM_BANK_CLAIM: el claim no trae examBank válido → contrato (D), no salida de la IA.
    refine: ({ code }) => (code === 'EXAM_BANK_CLAIM' ? { class: 'D', strategy: 'hold_for_human', rounds: 0, humanReason: 'product_bug', adminAction: 'regenerate_item' } : null),
  },
  {
    id: 'corrupt_dependency',
    codes: ['context_package_failed', 'context_package_invalid_json', 'course_plan_invalid', 'AUDIO_SCRIPT_EMPTY', 'AUDIOBOOK_CONTENT_EMPTY', 'AUDIO_WELCOME_TEXT_MISSING'],
    family: /^[a-z0-9_]+_empty$/,
    class: 'B', strategy: 'regenerate_dependency', rounds: 1,
  },
  {
    // I5: PDF/portada/PNG inválidos SOBRE una generación de Gamma ya existente (y pagada): re-descarga /
    // re-render GRATIS de la MISMA generación (A). Sin generationId persistido no hay de dónde re-bajar → B.
    id: 'presentation_output_invalid',
    codes: ['gamma_pdf_invalid', 'presentation_artifact_invalid'],
    family: /^(PDF|COVER|PNG)_[A-Z0-9_]+$/,
    class: 'B', strategy: 'regenerate_targeted', paidRisk: 'measured', provider: 'gamma', rounds: 1,
    refine: ({ outputSummary }) => (hasGammaId(outputSummary) ? { class: 'A', strategy: 'repoll_external', paidRisk: 'none' } : null),
  },
  {
    // Cantidad de diapositivas: la generación misma es la equivocada → una generación nueva (pagada, dentro del presupuesto).
    id: 'presentation_slide_count', codes: ['PRESENTATION_CARD_SLIDE_COUNT', 'SLIDE_COUNT'],
    class: 'B', strategy: 'regenerate_targeted', paidRisk: 'measured', provider: 'gamma', rounds: 1,
  },
  {
    // I5: la generación falló en Gamma. Si Gamma no informó los créditos, el cobro es INCIERTO → C (FinOps,
    // decisión del usuario D3 2026-10-02: incierto → política FinOps, nunca duplicar gasto solo). Solo con
    // créditos medidos (el worker lo anota en el mensaje) es una falla conocida → B (una generación nueva).
    id: 'gamma_generation_failed', codes: ['gamma_generation_failed'],
    class: 'C', strategy: 'hold_for_human', paidRisk: 'uncertain', provider: 'gamma', rounds: 0, humanReason: 'duplicate_charge', adminAction: 'reconcile_provider',
    // N4: anclado al SUFIJO que agrega el worker (real-providers.ts), nunca al texto de Gamma que va antes.
    refine: ({ error }) => (/\[créditos medidos: \d+(?:\.\d+)?\]\. No se reenvía sola/.test(error)
      ? { class: 'B', strategy: 'regenerate_targeted', paidRisk: 'measured', rounds: 1, humanReason: undefined, adminAction: undefined }
      : null),
  },
  {
    id: 'audio_invalid',
    codes: ['TTS_AUDIO_INVALID', 'AUDIOBOOK_PART_MISSING', 'MP3_INVALID', 'MP3_INCOMPATIBLE_PARTS', 'AUDIO_DURATION'],
    family: /^MP3_[A-Z0-9_]+$/,
    class: 'B', strategy: 'regenerate_targeted', paidRisk: 'measured', provider: 'openai', rounds: 2,
  },
  { id: 'audiobook_script_failed', codes: ['audiobook_script_failed'], class: 'A', strategy: 'retry_backoff', paidRisk: 'measured', provider: 'anthropic', rounds: 3 },

  // ── Contrato y producto (D) ────────────────────────────────────────────────
  // M7: ACTIVITY_TYPE_MISMATCH / EXAM_ARTIFACT_AMBIGUOUS existen en dos papeles. Como código INTERNO de
  // `v3_payload_invalid [..]` (prevalidación del servidor) la clase la decide el código de arriba (B). Como
  // código de PRIMER nivel del ejecutor («el claim pide X pero el Manifest dice Y») es un contrato roto (D).
  // La coincidencia exacta de esta regla solo aplica al primer nivel.
  {
    id: 'contract',
    codes: ['missing_dependency_artifact', 'missing_content_artifact', 'missing_course_plan_artifact', 'ambiguous_course_plan_artifact',
      'duplicate_artifact_type', 'artifact_mismatch', 'artifacts_not_linkable', 'exam_content_missing', 'EXAM_ARTIFACT_AMBIGUOUS',
      'claim_contract', 'VIDEO_PLAN_MISMATCH', 'VIDEO_REFLECTION_PLAN_MISMATCH', 'ACTIVITY_TYPE_NOT_IN_MANIFEST', 'unsupported_item_type',
      'unsupported_rules_version', 'rules_version_mismatch', 'claim_payload_unavailable', 'video_duration_unmeasurable',
      'missing_artifact_id', 'artifact_download_unavailable', 'unsupported_download_method', 'provider_worker_wrong_type',
      'missing_required_artifacts', 'ACTIVITY_TYPE_MISMATCH'],
    family: /^(missing|ambiguous)_[a-z0-9_]+_artifact$/,
    class: 'D', strategy: 'hold_for_human', rounds: 0, humanReason: 'product_bug', adminAction: 'regenerate_item',
  },
  { id: 'v3_validator_infra', codes: ['v3_validator_unavailable', 'v3_artifact_unreadable', 'V3_VALIDATION_CONTEXT'], class: 'A', strategy: 'retry_backoff', rounds: 2 },

  // ── Video (Videogen) ───────────────────────────────────────────────────────
  {
    id: 'video_repoll', codes: ['video_timeout', 'video_duration_unmeasured'], class: 'A', strategy: 'repoll_external', provider: 'videogen', rounds: 3,
    refine: ({ outputSummary }) => (hasVideogenJob(outputSummary) ? null : { strategy: 'retry_backoff' }),
  },
  { id: 'videogen_submit_rejected', codes: ['videogen_submit_rejected'], class: 'A', strategy: 'retry_backoff', provider: 'videogen', rounds: 1 },
  {
    id: 'video_ambiguous',
    codes: ['ambiguous_video_submission', 'video_upgrade_ambiguous_submission', 'reserved_without_submit_marker'],
    class: 'C', strategy: 'provider_check', paidRisk: 'uncertain', provider: 'videogen', rounds: 1, humanReason: 'duplicate_charge', adminAction: 'reconcile_videogen',
  },
  // Decisión del usuario D4 (2026-10-02): render fallido con cobro incierto → política FinOps, nunca un reenvío
  // automático que duplique gasto. «El proveedor confirma que no cobró → puede reintentar» llega con R8.
  { id: 'videogen_failed', codes: ['videogen_failed'], class: 'C', strategy: 'hold_for_human', paidRisk: 'uncertain', provider: 'videogen', rounds: 0, humanReason: 'duplicate_charge', adminAction: 'retry_video_render' },
  {
    id: 'provider_config',
    codes: ['videogen_not_configured', 'real_video_not_allowed', 'video_preview_not_allowed', 'PROVIDER_MODE_UNSET', 'provider_mode_unset',
      'mock_not_allowed', 'provider_mock_not_allowed', 'paid_real_provider_requires_admin_approval', 'real_spend_requires_human_approval',
      'provider_not_ready', 'video_delivery_not_youtube', 'videogen_rejected_definitively', 'GAMMA_COVER_RASTERIZER_UNAVAILABLE',
      'theme_resolution_failed', 'gamma_rejected_definitively', 'openai_tts_rejected_definitively', 'insufficient_quota'],
    family: /^(provider_mode_[a-z_]+|GAMMA_THEME_[A-Z0-9_]+)$/,
    class: 'D', strategy: 'hold_for_human', scope: 'provider', rounds: 0, humanReason: 'config', adminAction: 'retry_item',
  },

  // ── YouTube ────────────────────────────────────────────────────────────────
  { id: 'youtube_upload_failed', codes: ['youtube_upload_failed'], class: 'A', strategy: 'retry_backoff', provider: 'youtube', rounds: 3 },
  {
    id: 'youtube_ambiguous', codes: ['youtube_upload_ambiguous', 'ambiguous_youtube_upload', 'youtube_ambiguous'],
    class: 'C', strategy: 'provider_check', paidRisk: 'none', provider: 'youtube', rounds: 1, adminAction: 'resolve_youtube',
  },
  { id: 'youtube_quota', codes: ['youtube_blocked_quota', 'wait_quota', 'blocked_quota'], class: 'A', strategy: 'wait_provider', scope: 'provider', provider: 'youtube', rounds: 3 },
  {
    id: 'youtube_auth',
    codes: ['youtube_blocked_auth', 'blocked_auth', 'reauth_required', 'reconnect_youtube', 'youtube_preflight_failed', 'needs_youtube_preflight',
      'channel_unresolved', 'youtube_publisher_not_configured', 'oauth_failed'],
    class: 'D', strategy: 'hold_for_human', scope: 'provider', provider: 'youtube', rounds: 0, humanReason: 'config', adminAction: 'resolve_youtube',
  },
  {
    id: 'youtube_verify',
    codes: ['youtube_video_not_verified', 'video_not_unlisted', 'video_not_found', 'video_not_owned', 'video_id_invalid', 'youtube_invalid_url', 'video_lookup_failed'],
    class: 'A', strategy: 'repoll_external', provider: 'youtube', rounds: 2,
  },
  {
    id: 'youtube_delivery',
    codes: ['youtube_delivery_incomplete', 'youtube_delivery_without_videogen_job', 'youtube_missing_videogen_download_url',
      'v3_requires_youtube_delivery', 'invalid_video_delivery'],
    class: 'B', strategy: 'regenerate_dependency', provider: 'youtube', rounds: 1,
  },

  // ── Gamma ──────────────────────────────────────────────────────────────────
  {
    id: 'gamma_repoll', codes: ['gamma_timeout', 'gamma_poll_failed', 'gamma_export_missing', 'gamma_pdf_download_failed'],
    class: 'A', strategy: 'repoll_external', provider: 'gamma', rounds: 3,
    refine: ({ outputSummary }) => (hasGammaId(outputSummary) ? null : { strategy: 'retry_backoff' }),
  },
  { id: 'gamma_submit_failed', codes: ['gamma_submit_failed'], class: 'A', strategy: 'retry_backoff', provider: 'gamma', rounds: 1 },
  // Decisión del usuario D3 (2026-10-02): envío incierto (sin generationId) → política FinOps, nunca duplicar
  // gasto solo. «El proveedor confirma que no cobró → puede reintentar» llega con R8.
  {
    id: 'gamma_ambiguous', codes: ['gamma_submit_ambiguous', 'ambiguous_gamma_submission'],
    class: 'C', strategy: 'hold_for_human', paidRisk: 'uncertain', provider: 'gamma', rounds: 0, humanReason: 'duplicate_charge', adminAction: 'reconcile_provider',
  },
  { id: 'gamma_cover_render', codes: ['GAMMA_COVER_RENDER_FAILED'], class: 'A', strategy: 'retry_backoff', provider: 'gamma', rounds: 1 },

  // ── TTS (OpenAI) ───────────────────────────────────────────────────────────
  {
    // Antes del primer trozo cobrado → A. Después de trozos ya cobrados (chunk N/M, N > 1) → C (user decision 1).
    id: 'tts_failed', codes: ['tts_failed'], class: 'A', strategy: 'retry_backoff', paidRisk: 'measured', provider: 'openai', rounds: 3,
    refine: ({ error }) => {
      const n = ttsPaidChunks(error);
      return n > 0 ? { class: 'C', strategy: 'auto_resubmit_once', rounds: 1, adminAction: 'reconcile_provider', humanReason: 'duplicate_charge', paidRisk: 'uncertain' } : null;
    },
  },
  {
    id: 'provider_reconciliation',
    codes: ['provider_reconciliation_required', 'confirm_paid_required', 'may_have_rendered_ack_required'],
    // #583 (decisión A del usuario): TTS de OpenAI incierto en un item de audio → UN reenvío automático acotado
    // (≤ USD 0.10 pendiente en el ledger, lo verifica auto-heal bajo lock); sigue siendo C (pago incierto).
    refine: ({ error, itemType }) => (/^provider_reconciliation_required: openai(?![a-z0-9_])/.test(error)
      && (itemType === 'audio_welcome' || itemType === 'audiobook_chapter')
      ? { strategy: 'auto_resubmit_once', provider: 'openai' }
      : null),
    class: 'C', strategy: 'provider_check', paidRisk: 'uncertain', rounds: 1, humanReason: 'duplicate_charge', adminAction: 'reconcile_provider',
  },
] as Rule[]);

/** Empaque (scope package, R9). El código sale de CUALQUIER token en mayúsculas conocido del mensaje. */
const PACKAGE_RULES: readonly Rule[] = Object.freeze([
  { id: 'package_transient', codes: ['PACKAGING_V3_CONTENT_MISSING', 'ERR_BUFFER_TOO_LARGE', 'package_transient'], class: 'A', strategy: 'repackage', scope: 'package', rounds: 5 },
  {
    id: 'package_component',
    codes: ['EXAM_BANK_INVALID', 'QUIZ_V3_BANK_INVALID', 'QUIZ_V3_EMPTY', 'QUIZ_V3_INVALID', 'H5P_ACTIVITY_PAYLOAD_INVALID', 'H5P_INPUT_INVALID',
      'H5P_BS_INVARIANT', 'H5P_DIALOG_CARDS_INVALID', 'VIDEO_INTRO_INVALID', 'VIDEO_YOUTUBE_ID_MISSING', 'VIDEO_DURATION_MISSING',
      'ACTIVITY_INTRO_INVALID', 'LIBRO_V3_INVALID', 'MODULE_INTRO_V3', 'COURSE_INTRO_V3', 'MODULE_INTRO_EXPECT_INVALID', 'SCORM_MANIFEST_INVALID',
      'ANSWER_LEAK', 'NUMBER_NOT_FROM_FACTS', 'SHELL_NUMBER_NOT_FROM_FACTS', 'EXAM_BANK_PLAN', 'EXAM_BANK_CONTEXT', 'VIDEO_PLAN_INVARIANT',
      'VIDEO_DURATION_INVALID', 'VIDEO_TOO_SHORT_FOR_INTERACTIONS', 'PRESENTATION_CARD_SLIDE_COUNT'],
    family: /^(H5P_PACKAGE_[A-Z0-9_]+|VIDEO_ACTIVITY_[A-Z0-9_]+)$/,
    class: 'B', strategy: 'repair_package', scope: 'package', rounds: 1,
  },
  {
    id: 'package_product',
    codes: ['SHELL_RENDER', 'LOW_CONTRAST', 'PACKAGING_PLAN_V3_INVALID', 'PACKAGING_V3_NOT_IMPLEMENTED', 'ID_ALLOCATOR', 'FILES_INTEGRITY',
      'SECTION_LAYOUT_INVALID', 'COURSE_BADGE_INVALID', 'SYNTHETIC_MEDIA_INVALID', 'TOKEN_INVALID', 'VC_INVALID', 'VC_RENDER',
      'CURSIA_IV_INLINE_SCRIPT_PKG', 'H5P_NOT_GRADABLE_IN_MOODLE', 'ACTIVITY_INTRO_THEME', 'GAMMA_THEME_CONFIG', 'FACTS_INVALID',
      'VIDEO_PACKAGE_FILENAME_INVALID', 'ACTIVITY_PACKAGE_FILENAME_INVALID', 'V3_VALIDATION_CONTEXT', 'PNG_ENCODE', 'PNG_UNSUPPORTED',
      'PACKAGE_BUILDER_ERROR',
      // r19 L: asset del logo de Cursia ausente/roto (deploy) o invariante de una marca de agua por página.
      'LIBRO_LOGO_ASSET_MISSING', 'LIBRO_LOGO_ASSET_INVALID', 'LIBRO_V3_WATERMARK',
      // r19 L fix round 1 (I1): pdfkit no pudo generar el Libro Guía (ni con el logo de Cursia) → bug de producto.
      'LIBRO_V3_PDF_FAILED'],
    family: /^(MBZ_V3_[A-Z0-9_]+|ASSESSMENT_[A-Z0-9_]+|WEIGHTS_[A-Z0-9_]+|THEME_[A-Z0-9_]+|H5P_PROFILE_[A-Z0-9_]+|H5P_PACK_[A-Z0-9_]+|H5P_L10N_[A-Z0-9_]+|H5P_PREFLIGHT_[A-Z0-9_]+|H5P_STORE_[A-Z0-9_]+|H5P_UUID_[A-Z0-9_]+|H5P_SUBCONTENT_[A-Z0-9_]+|MOCK_[A-Z0-9_]+|ACTIVITY_TYPE_INVALID_[A-Z0-9_]+)$/,
    class: 'D', strategy: 'hold_for_human', scope: 'package', rounds: 0, humanReason: 'product_bug', adminAction: 'retry_package',
  },
  {
    id: 'package_precheck', codes: ['pending_video_omitted', 'preview_not_deliverable', 'qa_preview', 'owner_not_allowed'],
    class: 'D', strategy: 'hold_for_human', scope: 'package', rounds: 0, humanReason: 'config', adminAction: 'resolve_package_block',
  },
] as Rule[]);

/** Restauración en Moodle (scope package, R10). */
const RESTORE_RULES: readonly Rule[] = Object.freeze([
  { id: 'restore_infra', family: /^RESTORE_INFRA_[A-Z0-9_]+$/, class: 'A', strategy: 'reverify', scope: 'package', rounds: 5 },
  { id: 'restore_precheck', codes: ['RESTORE_PRECHECK_ERROR'], class: 'B', strategy: 'repair_package', scope: 'package', rounds: 1 },
  {
    id: 'restore_product', codes: ['RESTORE_EXECUTE_FAILED', 'RESTORE_COUNTS_MISMATCH', 'RESTORE_H5P_DEPLOY_FAILED'],
    class: 'D', strategy: 'hold_for_human', scope: 'package', rounds: 0, humanReason: 'product_bug', adminAction: 'retry_package',
  },
] as Rule[]);

function ruleFor(rules: readonly Rule[], code: string): Rule | null {
  for (const r of rules) if (r.codes?.includes(code)) return r;
  for (const r of rules) if (r.family && r.family.test(code)) return r;
  return null;
}

/** ¿Hay una regla EXPLÍCITA (item, paquete o restauración) para este código? */
export function isFailureCodeClassified(code: string): boolean {
  return !!(ruleFor(ITEM_RULES, code) || ruleFor(PACKAGE_RULES, code) || ruleFor(RESTORE_RULES, code));
}

/** Todos los códigos exactos de la tabla (para el check y la documentación). */
export function classifiedCodes(): string[] {
  return [...new Set([...ITEM_RULES, ...PACKAGE_RULES, ...RESTORE_RULES].flatMap((r) => r.codes ?? []))].sort();
}

// ─── Extracción del código desde el mensaje ─────────────────────────────────

/** Tipos de item que el ejecutor usa como prefijo de un mensaje de contrato del claim («video_interactions: …»). */
const ITEM_TYPE_PREFIXES = new Set([
  'content', 'scorm', 'exam', 'video', 'course_plan', 'course_intro', 'module_intro', 'experience', 'video_interactions', 'activity',
  'final_exam', 'presentation', 'audio_welcome', 'audiobook_chapter',
]);

/** Frases estables del ejecutor del navegador / de api() (04-api.js) → código. Orden = prioridad. */
const PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/^(?:❌\s*)?Fall[oó] despu[eé]s de \d+ intentos\b/i, 'browser_llm_transient'],
  [/^no se pudo subir el artifact\b/i, 'artifact_upload_failed'],
  [/^complete rechazado\b/i, 'complete_rejected'],
  [/^OUTPUT_TRUNCATED_MAX_TOKENS\b/, 'OUTPUT_TRUNCATED_MAX_TOKENS'],
  [/^respuesta truncada \(stop_reason=max_tokens\)/i, 'llm_output_truncated'],
  [/inv[aá]lido tras reintento dirigido\b/i, 'validation_invalid'],
  [/^plan de conceptos( fusionado)? inv[aá]lido\b/i, 'concept_plan_invalid'],
  [/^SCORM v2 inv[aá]lido\b/i, 'scorm_invalid'],
  [/^contenido vac[ií]o\b/i, 'content_empty'],
  [/^GIFT\b.*\b(incompleto|inv[aá]lido)\b/i, 'gift_invalid'],
  [/^JSON inv[aá]lido\b/i, 'llm_output_invalid'],
  [/^falta la lista "questions"/i, 'llm_output_invalid'],
  [/^tipo no soportado\b/i, 'unsupported_item_type'],
  [/^rulesVersion no soportado\b/i, 'unsupported_rules_version'],
  [/^(?:❌\s*)?No tienes acceso\b/i, 'browser_auth'],
  [/^Sin sesi[oó]n activa\b/i, 'browser_session_missing'],
  [/^(?:❌\s*)?El servicio de IA de este entorno no est[aá] configurado/i, 'proxy_misconfigured'],
  [/^(?:❌\s*)?Sin disponibilidad de generaci[oó]n/i, 'llm_credit_exhausted'],
  [/^(?:❌\s*)?Error de configuraci[oó]n interna/i, 'llm_model_config'],
  [/^(?:❌\s*)?Error al procesar la solicitud\b/i, 'llm_request_rejected'],
  [/^Modelo no (?:seleccionado|permitido)\b/i, 'llm_model_missing'],
  [/^API key no configurada\b/i, 'llm_api_key_missing'],
  [/^Petici[oó]n demasiado grande\b/i, 'llm_request_too_large'],
  [/^Servidor ocupado\b|^Error del servidor\b|^Error de red\b/i, 'llm_transient'],
  [/^Respuesta vac[ií]a\b/i, 'llm_empty_response'],
  // cursia#68 (streaming SSE de api()): cortes del stream → transitorio de la IA.
  [/^La respuesta de la IA se cort[oó](?![a-z])|^Se cort[oó] la conexi[oó]n con la IA\b|^La IA dej[oó] de responder\b|^Respuesta de la IA incompleta\b/i, 'llm_stream_cut'],
  [/^Respuesta ilegible de la API\b/i, 'llm_empty_response'],
  [/^Generaci[oó]n detenida por el usuario\b/i, 'user_stopped'],
  [/^(fetch failed|network error|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/i, 'llm_network'],
];

/** Código de un mensaje en texto libre sin código reconocible (siempre sin regla → D retenido). */
export const UNCLASSIFIED_CODE = 'unclassified_error';

const UPPER_TOKEN_RE = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g;

/** Códigos internos entre corchetes de v3ValidationErrorMessage / tras `presentation_artifact_invalid:`. */
function innerCodesOf(error: string): string[] {
  const out = new Set<string>();
  const br = /\[([A-Z0-9_,\s]+)\]/.exec(error);
  if (br) for (const c of br[1].split(',').map((x) => x.trim()).filter(Boolean)) out.add(c);
  const m = /^(?:presentation_artifact_invalid|v3_payload_invalid):\s*([A-Z][A-Z0-9_]+(?:,\s*[A-Z][A-Z0-9_]+)*)/.exec(error);
  if (m) for (const c of m[1].split(',').map((x) => x.trim())) out.add(c);
  return [...out];
}

function httpStatusOf(error: string): number | null {
  const m = /\(HTTP (\d{3})\)|\bHTTP (\d{3})\b|^(?:❌\s*)?(?:Servidor ocupado|Error del servidor|Error de red) \((\d{3})\)|\bstatus[ =:]+(\d{3})\b/i.exec(error);
  if (!m) return null;
  const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

/** Código estable de un mensaje de error (sin errorCode explícito). */
export function extractFailureCode(error: string): string {
  const e = String(error ?? '').trim();
  if (!e) return 'unknown_error';
  for (const [re, code] of PHRASES) if (re.test(e)) return code;
  const lead = /^([A-Za-z][A-Za-z0-9_]*)(?=$|[\s:(—\-,.])/.exec(e);
  if (lead) {
    const tok = lead[1];
    // «<tipo>: …» / «activity h5p: …» = mensaje de contrato del claim del ejecutor: código interno si lo hay.
    if (ITEM_TYPE_PREFIXES.has(tok) && /^[a-z_]+(?: h5p)?:/.test(e)) {
      UPPER_TOKEN_RE.lastIndex = 0;
      for (const m of e.matchAll(UPPER_TOKEN_RE)) if (isFailureCodeClassified(m[1])) return m[1];
      return 'claim_contract';
    }
    // Un código estable siempre lleva '_' (lease_expired, EXAM_BANK_…): una palabra suelta («la portada…»,
    // «HTTP 503 …», «kaboom») es texto libre, no un código.
    if (tok.includes('_') && tok.length <= FAILURE_CODE_MAX) return tok;
  }
  // Texto libre sin código: desconocido (≠ `unknown_error`, que es el código del mensaje VACÍO del scheduler).
  return UNCLASSIFIED_CODE;
}

// ─── Comportamiento ACTUAL (auto-heal.ts, sin cambios) ──────────────────────

/** Qué haría HOY el sistema con este fallo (auto-healer R16 / reintento seguro BE-B). Informativo. */
export function currentRecoveryOf(
  error: string,
  itemType: string | null | undefined,
  outputSummary: Record<string, any> | null | undefined,
  /** Fix round 1 (I2): clase REGISTRADA al fallar (incluye la subida por errorCode); C/D nunca es auto-heal. */
  failureClass?: string | null,
): CurrentRecovery {
  const e = String(error ?? '').trim();
  const os = outputSummary ?? {};
  // #583: va ANTES de la deny-list (la deny-list describe justamente este caso incierto; la función de
  // auto-heal aplica su propia deny-list reducida).
  if (ambiguousAudioResubmitDecision({ status: 'failed', type: itemType ?? null, error: e, output_summary: os }, new Date()).heal) return 'ambiguous_audio_resubmit';
  const denied = AUTO_HEAL_DENY_PATTERNS.some((re) => re.test(e));
  const safe = SAFE_AUTO_RETRY_RULES.find((r) => r.match.test(e) && (!itemType || itemType === r.type));
  if (safe && !denied && safe.requires(os, e)) return 'safe_auto_retry';
  if (denied) return 'denied';
  // REL MVP: la MISMA decisión del auto-healer con la política vigente (por clase, o R16 con el kill-switch);
  // sin fecha de fallo (sin espera) y con las rondas ya usadas del item.
  const d = autoHealDecision({ status: 'failed', type: itemType ?? null, error: e, output_summary: os, failure_class: failureClass ?? null }, new Date(), autoHealPolicyFromEnv(process.env));
  if (d.heal) return d.kind === 'B' ? 'auto_regenerate' : 'auto_heal';
  return 'manual';
}

// ─── Clasificación ──────────────────────────────────────────────────────────

function verdictOf(rule: Rule, code: string, ctx: RefineCtx, extra: Partial<FailureVerdict>): FailureVerdict {
  // I1: cuota/crédito/auth de un proveedor ANTES de los refines del item (p.ej. el chunk N/M del TTS).
  const isProviderCall = Object.prototype.hasOwnProperty.call(PROVIDER_CALL_RULES, rule.id);
  const providerConfig = isProviderCall && PROVIDER_CONFIG_RE.test(ctx.error);
  let patch: Partial<Rule> | null;
  let extraCtx: Partial<FailureVerdict> = {};
  if (providerConfig) {
    const provider = PROVIDER_CALL_RULES[rule.id] ?? providerFromMessage(ctx.error) ?? providerFromItemType(ctx.itemType);
    const paidUnits = rule.id === 'tts_failed' ? ttsPaidChunks(ctx.error) : 0;
    extraCtx = { providerConfigIssue: true, ...(paidUnits > 0 ? { paidUnits } : {}) };
    if (paidUnits > 0) {
      // N5: trozos ya pagados y hoy un reintento re-sintetiza TODO (no hay cursor por trozo hasta R3/R8) → no se
      // puede garantizar que la reanudación no los vuelva a pagar → C (reconciliación), nunca retry_item.
      patch = { class: 'C', strategy: 'hold_for_human', scope: 'item', rounds: 0, humanReason: 'duplicate_charge', provider: provider ?? undefined,
        adminAction: 'reconcile_provider', paidRisk: 'uncertain' };
    } else if (provider) {
      patch = { class: 'D', strategy: 'wait_provider', scope: 'provider', rounds: 0, humanReason: 'config', provider, adminAction: 'retry_item' };
    } else {
      // N3: nunca scope provider sin proveedor (p.ej. un 403 del Storage en un unexpected_error) → D retenido, scope item.
      patch = { class: 'D', strategy: 'hold_for_human', scope: 'item', rounds: 0, humanReason: 'config', provider: undefined, adminAction: 'retry_item' };
    }
  } else {
    patch = rule.refine ? rule.refine(ctx) : null;
  }
  let r: Rule = patch ? { ...rule, ...patch } : rule;
  // N3: nunca scope provider sin proveedor — se deriva del código, del mensaje o del tipo de item; si no, scope item.
  if ((r.scope ?? 'item') === 'provider' && !r.provider) {
    const provider = providerFromCode(code) ?? providerFromMessage(ctx.error) ?? providerFromItemType(ctx.itemType);
    r = provider ? { ...r, provider } : { ...r, scope: 'item' };
  }
  extra = { ...extraCtx, ...extra };
  if (rule.id === 'tts_failed' && !providerConfig && ttsPaidChunks(ctx.error) > 0) extra = { paidUnits: ttsPaidChunks(ctx.error), ...extra };
  return {
    class: r.class,
    code: code.slice(0, FAILURE_CODE_MAX),
    strategy: r.strategy,
    scope: r.scope ?? 'item',
    paidRisk: r.paidRisk ?? 'none',
    targetRounds: r.rounds,
    provider: r.provider ?? null,
    adminAction: r.adminAction ?? null,
    humanReason: r.humanReason ?? null,
    rule: rule.id,
    unclassified: false,
    httpStatus: ctx.httpStatus,
    ...extra,
  };
}

/** HTTP de la IA sin código reconocible (gateway del servidor / mensajes crudos). */
function httpFallbackCode(status: number, error: string): string | null {
  if (status === 413) return 'llm_request_too_large';
  if (status === 429 || status === 408 || status === 529 || (status >= 500 && status <= 599)) return 'llm_transient';
  if (status === 400 && /credit|balance/i.test(error)) return 'llm_credit_exhausted';
  if (status === 401 || status === 403) return 'llm_auth_rejected';
  if (status === 400) return 'llm_request_rejected';
  return null;
}

/**
 * Clasifica un fallo. Nunca lanza. `source: 'package_worker' | 'restore_worker'` usa las tablas de
 * empaque/restauración (códigos en mayúsculas en cualquier parte del mensaje); el resto, la de items.
 */
export function classifyFailure(input: FailureInput): FailureVerdict {
  const error = String(input?.error ?? '').trim();
  const os = (input?.outputSummary ?? {}) as Record<string, any>;
  const itemType = input?.itemType ?? null;
  const httpStatus = (typeof input?.httpStatus === 'number' ? input.httpStatus : null) ?? httpStatusOf(error);
  const ctxBase = { error, httpStatus, outputSummary: os, itemType };
  const scoped = input?.source === 'package_worker' ? PACKAGE_RULES : input?.source === 'restore_worker' ? RESTORE_RULES : null;

  if (scoped) {
    const lead = extractFailureCode(error);
    const lr = ruleFor(scoped, lead);
    if (lr) return verdictOf(lr, lead, { ...ctxBase, code: lead }, {});
    for (const m of error.matchAll(UPPER_TOKEN_RE)) {
      const r = ruleFor(scoped, m[1]);
      if (r) return verdictOf(r, m[1], { ...ctxBase, code: m[1] }, {});
    }
    if (/download|timeout|ETIMEDOUT|ECONNRESET|fetch failed|HTTP 5\d\d|storage/i.test(error)) {
      const tc = scoped === PACKAGE_RULES ? 'package_transient' : 'RESTORE_INFRA_UNKNOWN';
      const r = ruleFor(scoped, tc);
      if (r) return verdictOf(r, tc, { ...ctxBase, code: tc }, {});
    }
    return unclassifiedVerdict(extractFailureCode(error), httpStatus, 'package', 'none');
  }

  return moneyFloor(classifyItem(input, error, ctxBase), error);
}

/**
 * N2: piso de dinero en RUNTIME. Si el texto del fallo coincide con la deny-list de dinero del auto-healer
 * (presupuesto, reconciliación, ambiguo, cuota/saldo, configuración…) el veredicto es AL MENOS C, sea cual sea
 * el código de adelante (p.ej. `unexpected_error: budget_exceeded: …`). Excepción: las esperas de proveedor
 * (`wait_provider`, p.ej. la cuota de YouTube, que ya es una espera sin gasto).
 */
const MONEY_FLOOR_EXTRA: readonly RegExp[] = Object.freeze([/\bsaldo\b/i]);
function moneyFloor(v: FailureVerdict, error: string): FailureVerdict {
  if (v.class === 'C' || v.class === 'D' || v.strategy === 'wait_provider') return v;
  // Códigos de VALIDACIÓN que contienen la palabra (EXAM_ARTIFACT_AMBIGUOUS = dos artifacts de examen, no un pago)
  // no cuentan: el piso mira el texto, no los códigos internos ya clasificados.
  const text = error.replace(/\bEXAM_ARTIFACT_AMBIGUOUS\b/g, '');
  if (!AUTO_HEAL_DENY_PATTERNS.some((re) => re.test(text)) && !MONEY_FLOOR_EXTRA.some((re) => re.test(text))) return v;
  const budget = /budget|presupuesto/i.test(text);
  const config = /not_allowed|not_configured|not_ready|provider_mode_unset|mock_not_allowed|blocked_auth|youtube_preflight/i.test(text);
  return {
    ...v,
    class: 'C',
    strategy: 'hold_for_human',
    targetRounds: 0,
    paidRisk: budget || config ? v.paidRisk : 'uncertain',
    humanReason: budget ? 'budget' : config ? 'config' : 'duplicate_charge',
    adminAction: budget ? 'approve_budget' : config ? 'retry_item' : 'reconcile_provider',
    moneyFloor: true,
  };
}

function classifyItem(input: FailureInput, error: string, ctxBase: Omit<RefineCtx, 'code'>): FailureVerdict {
  // Veredicto del MENSAJE (hecho del servidor / del emisor).
  const messageVerdict = classifyMessage(error, ctxBase, input?.source ?? null);
  if (!isValidFailureCode(input?.errorCode)) return messageVerdict;
  // C1: errorCode reportado — no de confianza. Solo SUBE la severidad.
  const reported = input.errorCode;
  const codeRule = ruleFor(ITEM_RULES, reported);
  const ignored = (v: FailureVerdict): FailureVerdict => ({ ...v, reportedCode: reported, reportedCodeIgnored: true });
  if (!codeRule) return ignored(messageVerdict);
  if (input?.source === 'browser_executor' && !BROWSER_REPORTABLE_RULES.has(codeRule.id)) return ignored(messageVerdict);
  const codeVerdict = verdictOf(codeRule, reported, { ...ctxBase, code: reported }, withInner(reported, error));
  const msgSev = SEVERITY[messageVerdict.class];
  const codeSev = SEVERITY[codeVerdict.class];
  // Mismo nivel: gana el mensaje (hecho), salvo que el mensaje no se haya podido clasificar.
  const useCode = codeSev > msgSev || (codeSev === msgSev && messageVerdict.unclassified);
  if (!useCode) return ignored(messageVerdict);
  return {
    ...codeVerdict,
    paidRisk: PAID_RISK_ORDER[Math.max(PAID_RISK_ORDER.indexOf(codeVerdict.paidRisk), PAID_RISK_ORDER.indexOf(messageVerdict.paidRisk))],
    reportedCode: reported,
    reportedCodeIgnored: false,
  };
}

const SEVERITY: Readonly<Record<FailureClass, number>> = Object.freeze({ A: 0, B: 1, C: 2, D: 3 });
const PAID_RISK_ORDER: readonly PaidRisk[] = Object.freeze(['none', 'measured', 'uncertain'] as PaidRisk[]);

/**
 * C1: reglas cuyos códigos el ejecutor del NAVEGADOR puede producir de verdad (salida de la IA, su propio
 * transporte/Storage, contrato del claim). Un código del navegador de cualquier otra regla (lease, drain,
 * presupuesto, pagos ambiguos, reconciliación, proveedores, workers) se registra como reportado y se ignora.
 */
const BROWSER_REPORTABLE_RULES: ReadonlySet<string> = new Set([
  'unknown_error', 'download_failed', 'exam_bank_chapter_md_missing', 'artifact_upload_failed', 'complete_rejected',
  'browser_auth', 'user_stopped', 'llm_transient', 'llm_config', 'llm_request_rejected', 'llm_too_large', 'output_truncated',
  'v3_payload_invalid', 'validation_invalid', 'exam_bank_invalid', 'corrupt_dependency', 'contract',
]);

/** Fuentes cuyos mensajes son llamadas HTTP a la IA (I4: solo ahí el status HTTP decide). */
const LLM_HTTP_SOURCES: ReadonlySet<string> = new Set(['browser_executor', 'server_executor', 'llm_gateway']);

function classifyMessage(error: string, ctxBase: Omit<RefineCtx, 'code'>, source: FailureSource | null): FailureVerdict {
  const code = extractFailureCode(error);
  const rule = ruleFor(ITEM_RULES, code);
  if (rule) return verdictOf(rule, code, { ...ctxBase, code }, withInner(code, error));
  // I4: el status HTTP solo clasifica mensajes de llamadas HTTP de la IA (identificadas por la fuente).
  if (ctxBase.httpStatus !== null && source && LLM_HTTP_SOURCES.has(source)) {
    const hc = httpFallbackCode(ctxBase.httpStatus, error);
    const hr = hc ? ruleFor(ITEM_RULES, hc) : null;
    if (hr && hc) return verdictOf(hr, hc, { ...ctxBase, code: hc }, {});
  }
  // Desconocido: D retenido (nunca A) + alerta de ingeniería.
  const workerSource = source === 'video_worker' || source === 'provider_worker';
  return unclassifiedVerdict(code, ctxBase.httpStatus, 'item', workerSource ? 'uncertain' : 'none');
}

function withInner(code: string, error: string): Partial<FailureVerdict> {
  if (code !== 'v3_payload_invalid' && code !== 'presentation_artifact_invalid') return {};
  const inner = innerCodesOf(error);
  return inner.length ? { innerCodes: inner } : {};
}

function unclassifiedVerdict(code: string, httpStatus: number | null, scope: Scope, paidRisk: PaidRisk): FailureVerdict {
  // I4: desconocido = D retenido por seguridad (humano + alerta de ingeniería), nunca un reintento automático.
  return {
    class: 'D',
    code: (isValidFailureCode(code) ? code : 'unknown_error').slice(0, FAILURE_CODE_MAX),
    strategy: 'hold_for_human',
    scope,
    paidRisk,
    targetRounds: 0,
    provider: null,
    adminAction: scope === 'package' ? 'retry_package' : 'retry_item',
    humanReason: 'unrecoverable',
    rule: 'unclassified',
    unclassified: true,
    httpStatus,
  };
}

/** Código con el que R3 alerta a ingeniería por un fallo sin clasificar (documentación / R3). */
export const UNCLASSIFIED_TERMINAL_CODE = 'unclassified_error';
