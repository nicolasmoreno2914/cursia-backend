// ─────────────────────────────────────────────────────────────────────────────
// r98 — ESCALERA DE REMEDIACIÓN de un fallo determinista conocido (sin migración: output_summary.remediation).
//
// Incidente (prod run 4c6a9f71): `audiobook_chapter` falló 6 veces con AUDIOBOOK_LANGUAGE_NOT_NEUTRAL. Cada reintento
// (automático y manual) repitió EXACTAMENTE la misma llamada con el mismo prompt, y el validador rechazó lo mismo.
// Principios del dueño: (1) si conocemos el error, el sistema hace algo DISTINTO solo; (2) el creador del curso nunca
// necesita a un admin; (3) cero intervención por curso.
//
// Huella (fingerprint) = tipo de item + código estable + regla del clasificador + códigos internos del validador
// (ordenados). NUNCA el texto libre del mensaje (cambia en cada intento: bloque, término, cifras).
//
// Escalones (por huella; un fallo con OTRA huella reinicia la cuenta; los transitorios A / C / esperas no cuentan):
//   r99 (principio 1: un error conocido lleva SOLO a un intento DISTINTO, desde la primera vez):
//   1.ª vez  → feedback: rung 1 — el próximo intento CAMBIA su entrada: los hallazgos del validador vuelven al prompt
//                         (output_summary.remediation.feedback; scheduler → brief pedagógico, worker del audiolibro).
//   2.ª vez  → rewrite:  rung 2 — reescritura desde cero con TODOS los hallazgos acumulados de la huella y otro enfoque
//                         (frases más cortas, sin los términos/datos señalados). Nunca se acepta una salida inválida
//                         (r99, principio 4: sin entrega degradada — la aceptación con marca de calidad de r98 se retiró).
//   3.ª vez+ → exhausted: rung 3 — mientras el auto-heal B tenga rondas propias, el pedido corregido viaja en ellas; al
//                         agotarse, la parte queda en PAUSA COMO BUG DE CURSIA (bug-hold.ts): sin intentos ni gasto,
//                         reporte para desarrollo («Falla común», umbral 1) y reanudación automática con el arreglo.
// Gasto: los intentos extra (≤ MAX_LADDER_GRANTS por huella) pasan por los guards de siempre (presupuesto de la parte,
// tope del run, autorización vigente). Ninguna aprobación nueva.
// Puro salvo el reloj.
// ─────────────────────────────────────────────────────────────────────────────
import type { FailureVerdict } from './failure-classifier';
import { FAILURE_CODE_SOURCES } from './failure-classifier';
import { redactErrorExcerpt } from './attempt-log';
import type { BugHoldState } from './bug-hold';

export const REMEDIATION_KEY = 'remediation';
export const QUALITY_KEY = 'quality';
/** Intentos concedidos por la escalera (rung 1 + rung 2) por huella. Tope duro. */
export const MAX_LADDER_GRANTS = 2;
/** Tope TOTAL de intentos concedidos por la escalera a una parte (todas sus huellas, reintentos humanos incluidos). */
export const MAX_LADDER_GRANTS_PER_ITEM = 3;
export const REMEDIATION_FEEDBACK_MAX = 1200;
export const REMEDIATION_FINDINGS_MAX = 10;
export const REMEDIATION_PREVIOUS_MAX = 5;

/**
 * Lista EXPLÍCITA y corta de validadores que pueden degradar a «aceptado con marca de calidad» (rung 2). Solo calidad
 * de redacción no crítica, y solo donde la aceptación está cableada de verdad:
 *  - LANGUAGE_NOT_NEUTRAL: scheduler.prevalidateV3 (contenido + artifacts v3, revalida con la estructura intacta) y el
 *    ejecutor (45-dynamic-generation-executor.js: lo de idioma pasa a blando);
 *  - AUDIOBOOK_LANGUAGE_NOT_NEUTRAL: generateSectionScript (audio-scripts.ts).
 * NUNCA: JSON inválido, campos/archivos faltantes, estructura, veracidad (CONTENT_TRUTH / FABRICATED_DATA), banco de
 * examen, paquete, presupuesto… (cualquier código fuera de esta lista termina en rung 3).
 */
// r99 (principio 4 del dueño: «el curso no se debe entregar con errores»): la aceptación con marca de calidad se RETIRÓ.
// La lista queda vacía a propósito (los consumidores — scheduler.prevalidateV3, generateSectionScript y el ejecutor 45,
// que solo ablanda con `acceptCodes` del rung 2 — ya no aceptan nada). check-r99-remediation-strategies lo exige.
export const DEGRADABLE_CODES: readonly string[] = Object.freeze([] as string[]);

/** Motivo para el usuario/admin cuando la escalera se agotó (rung 3). */
// r99: la escalera agotada es un bug de Cursia (pausa + reporte + reanudación automática), nunca una carga del usuario.
export const REMEDIATION_EXHAUSTED_REASON =
  'Encontramos un problema de nuestro lado y lo estamos resolviendo. No tienes que hacer nada; tu curso continuará automáticamente.';
export const REMEDIATION_EXHAUSTED_CODE = 'remediation_exhausted';

export type LadderAction = 'observe' | 'feedback' | 'rewrite' | 'exhausted';

export interface RemediationState {
  v: 1;
  fingerprint: string;
  code: string;
  rule: string;
  itemType: string | null;
  innerCodes: string[];
  /** Fallos CONSECUTIVOS (deterministas) con esta huella. */
  count: number;
  /** 0 observar · 1 feedback · 2 reescribir con todos los hallazgos · 3 agotada (pausa como bug de Cursia). */
  rung: 0 | 1 | 2 | 3;
  firstAt: string;
  lastAt: string;
  /** Hallazgos del validador (del mensaje, recortados y sin secretos). */
  findings: string[];
  /** Texto que el próximo intento agrega a su prompt (rung ≥ 1). */
  feedback: string | null;
  /** r98 (retirado en r99): siempre vacío — ningún intento acepta una salida inválida. */
  acceptCodes: string[];
  /** Intentos concedidos por la escalera para esta huella (≤ MAX_LADDER_GRANTS). */
  grants: number;
  /** Intentos concedidos por la escalera a la parte en total (≤ MAX_LADDER_GRANTS_PER_ITEM; nunca se reinicia). */
  grantsTotal?: number;
  /** Reintento humano (dueño/admin): nuevo ciclo de la escalera (count=1) conservando feedback y `previous`. */
  manualResetAt?: string | null;
  /** Escalones probados con su resultado (para el reporte de desarrollo). */
  tried: Array<{ rung: number; at: string; outcome: string }>;
  /** Último mensaje de error (recortado y sin secretos): solo para el reporte. */
  sampleError: string | null;
  /** rung 3: error exacto (≤ 500) que agotó la escalera — los barridos automáticos lo comparan. */
  exhaustedError?: string | null;
  exhaustedAt?: string | null;
  /** Desenlace al completar la parte (recordItemCompleted): 'accepted' (rung 2) | 'completed'. */
  outcome?: string | null;
  /** Huellas anteriores de esta parte (resumen acotado). */
  previous?: Array<{ fingerprint: string; count: number; rung: number; lastAt: string }>;
}

/**
 * Códigos que YA cambian su entrada en cada reintento con una escalera propia (no los toca esta escalera): audio de un
 * segmento (escalera A2 de r67: instructions → split, output_summary.audioRetryStrategy) y la repetición del guion del
 * audiolibro (descarta y regenera solo los bloques implicados).
 */
export const SELF_ADAPTIVE_CODES: readonly string[] = Object.freeze([
  'AUDIO_WPM_OUT_OF_RANGE', 'AUDIOBOOK_SEGMENT_DUPLICATE', 'TTS_AUDIO_INVALID', 'AUDIO_STRATEGIES_EXHAUSTED', 'AUDIOBOOK_SCRIPT_REPETITION',
  // Banco de examen incompleto: cada intento reanuda desde el borrador guardado (output_summary.examBankDraft) y avanza.
  'EXAM_BANK_INCOMPLETE',
  // Claim incompleto por el dato de una dependencia: lo resuelve su propio barrido (regenera la dependencia, r62 d8).
  'claim_payload_unavailable',
]);

/**
 * D que SÍ entran a la escalera (lista explícita; hoy vacía). Un D `hold_for_human` / `unrecoverable` (p. ej.
 * EXAM_BANK_LEAF_CAPACITY) o sin clasificar no se reintenta con feedback: su intento extra pagaría una llamada que no
 * puede salir bien, y los «unclassified» colapsarían en una sola huella (falsas «Falla común»).
 */
export const LADDER_D_CODES: readonly string[] = Object.freeze([] as string[]);

/**
 * ¿El veredicto describe un fallo DETERMINISTA que la escalera puede remediar? Clase B (salida de la IA inválida) y los
 * D de LADDER_D_CODES. Nunca: sin clasificar, riesgo de pago incierto o piso de dinero (decide la conciliación).
 */
export function isDeterministicVerdict(v: Pick<FailureVerdict, 'class' | 'strategy' | 'humanReason'> & { code?: string; unclassified?: boolean; paidRisk?: string; moneyFloor?: boolean }): boolean {
  if (v.code && SELF_ADAPTIVE_CODES.includes(v.code)) return false;
  if (v.unclassified || v.paidRisk === 'uncertain' || v.moneyFloor) return false;
  if (v.class === 'B') return true;
  return v.class === 'D' && !!v.code && LADDER_D_CODES.includes(v.code) && v.strategy !== 'hold_for_human';
}

/** Huella normalizada: tipo + código + regla + códigos internos (ordenados). Nunca el texto libre. */
export function failureFingerprintOf(v: Pick<FailureVerdict, 'code' | 'rule' | 'innerCodes'>, itemType: string | null | undefined): string {
  const inner = [...new Set((v.innerCodes ?? []).map(String))].sort();
  return [String(itemType ?? '-'), v.code, v.rule, inner.join(',')].join('|').slice(0, 200);
}

/** Hallazgos del validador desde el mensaje (después del primer «: »; separados por «; » o « | »). */
export function findingsOfError(error: string): string[] {
  const s = String(redactErrorExcerpt(error) ?? '');
  const idx = s.search(/:\s/);
  const body = idx >= 0 ? s.slice(idx + 2) : s;
  // «… no está en español neutro: X; Y» → la lista va después del último «: » de la cabecera.
  const tail = /no está en español neutro:\s*(.*)$/.exec(body)?.[1] ?? body;
  return tail.split(/;\s+|\s\|\s/).map((x) => x.trim()).filter(Boolean).slice(0, REMEDIATION_FINDINGS_MAX).map((x) => x.slice(0, 160));
}

/** Texto que se agrega al prompt del próximo intento (rung 1). */
export function feedbackFor(code: string, innerCodes: readonly string[], findings: readonly string[], rung: 1 | 2 = 1): string {
  const codes = new Set([code, ...innerCodes]);
  const list = findings.length ? findings.join('; ') : '(sin detalle)';
  const lines: string[] = [rung === 2
    ? 'CORRECCIÓN OBLIGATORIA (el pedido ya fue rechazado varias veces por la misma causa; cambia de enfoque):'
    : 'CORRECCIÓN OBLIGATORIA (el intento anterior fue rechazado por esta causa):'];
  if (codes.has('browser_output_exception')) {
    // r99 (review P1-1): el ejecutor no pudo leer la salida (JSON inválido / campos faltantes).
    lines.push(`- La respuesta anterior no se pudo leer (${list}). Responde SOLO con el formato pedido (JSON válido y completo, con todos los campos requeridos), sin texto antes ni después.`);
  } else if ([...codes].some((c) => /LANGUAGE_NOT_NEUTRAL$/.test(c))) {
    lines.push(`- Escribe en español latinoamericano neutro (tuteo «tú», «ustedes» para el plural; sin voseo ni regionalismos). Evita estos términos: ${list}; si son parte del contenido del curso, cítalos entre comillas.`);
  } else if ([...codes].some((c) => /^(CONTENT_TRUTH|FABRICATED_DATA|OUTDATED_CLAIM|QUANTITY_CLAIM)/.test(c))) {
    lines.push(`- No uses cifras, fechas, estudios ni datos que no estén en la fuente. Hallazgos: ${list}.`);
  } else {
    lines.push(`- El validador (${[...codes].join(', ')}) rechazó: ${list}. Corrige exactamente esos puntos.`);
  }
  // r99 (rung 2): otro enfoque, no el mismo pedido con una nota: reescritura desde cero, más simple y más corta.
  if (rung === 2) lines.push('- Reescribe esta parte DESDE CERO (no edites la versión anterior): frases cortas y simples, solo lo que está en la fuente, y revisa cada punto de la lista antes de responder.');
  return lines.join('\n').slice(0, REMEDIATION_FEEDBACK_MAX);
}

export function remediationOf(os: Record<string, any> | null | undefined): RemediationState | null {
  const r = os?.[REMEDIATION_KEY];
  return r && typeof r === 'object' && typeof r.fingerprint === 'string' ? (r as RemediationState) : null;
}

/** ¿Todos los códigos de la huella son degradables? */
export function isDegradableFingerprint(code: string, innerCodes: readonly string[]): boolean {
  const codes = innerCodes.length ? innerCodes : [code];
  return codes.length > 0 && codes.every((c) => DEGRADABLE_CODES.includes(c));
}

export interface LadderStep {
  state: RemediationState;
  action: LadderAction;
  /** ¿Conceder un intento extra para el escalón (rung 1/2)? */
  grant: boolean;
}

/**
 * Próximo estado de la escalera ante un fallo. null = el fallo no es determinista (no toca la escalera).
 * `retryable` = el emisor dice que otro intento puede servir; `paidUncertain` = riesgo de pago incierto (nunca se
 * conceden intentos extra: esos los decide la conciliación).
 */
export function ladderStep(
  prev: RemediationState | null,
  verdict: Pick<FailureVerdict, 'class' | 'strategy' | 'humanReason' | 'code' | 'rule' | 'innerCodes' | 'paidRisk'> & { unclassified?: boolean; moneyFloor?: boolean },
  itemType: string | null | undefined,
  error: string,
  now: Date,
  /**
   * `autoRegenSpent` (review P0-1): la regeneración automática PROPIA de la clase B (auto-heal, regenMaxRounds) ya se
   * usó o no aplica a este item. Mientras le queden rondas, la escalera no se agota: el feedback viaja en esas rondas.
   * Ausente = true (sin auto-regeneración que esperar).
   */
  opts: { retryable: boolean; autoRegenSpent?: boolean },
): LadderStep | null {
  if (!isDeterministicVerdict(verdict)) return null;
  const fp = failureFingerprintOf(verdict, itemType);
  const at = now.toISOString();
  const inner = [...new Set((verdict.innerCodes ?? []).map(String))].sort();
  const same = prev && prev.fingerprint === fp && !prev.outcome;
  const previous = prev && !same
    ? [...(prev.previous ?? []), { fingerprint: prev.fingerprint, count: prev.count, rung: prev.rung, lastAt: prev.lastAt }].slice(-REMEDIATION_PREVIOUS_MAX)
    : prev?.previous ?? [];
  const count = same ? prev!.count + 1 : 1;
  // r99 (rung 2): los hallazgos se ACUMULAN dentro de la huella (cada intento puede señalar otros términos / datos).
  const findings = [...new Set([...(same ? prev!.findings ?? [] : []), ...findingsOfError(error)])].slice(-REMEDIATION_FINDINGS_MAX);
  let rung: RemediationState['rung'];
  let action: LadderAction;
  // r99: el intento distinto empieza en el PRIMER rechazo (principio 1), nunca un segundo intento idéntico.
  if (count <= 1) { rung = 1; action = 'feedback'; }
  else if (count === 2) { rung = 2; action = 'rewrite'; }
  else if (opts.autoRegenSpent === false) { rung = 2; action = 'rewrite'; }
  else { rung = 3; action = 'exhausted'; }
  const grantsUsed = same ? prev!.grants : 0;
  const grantsTotalUsed = Math.max(Number(prev?.grantsTotal ?? 0) || 0, same ? grantsUsed : 0);
  // Con rondas propias de auto-regeneración pendientes (count ≥ 3) el pedido corregido viaja en ESAS rondas: sin intento
  // extra de la escalera.
  const ridingRegen = count >= 3 && action === 'rewrite';
  const canGrant = opts.retryable && verdict.paidRisk !== 'uncertain' && grantsUsed < MAX_LADDER_GRANTS
    && grantsTotalUsed < MAX_LADDER_GRANTS_PER_ITEM && !ridingRegen;
  const grant = (action === 'feedback' || action === 'rewrite') && canGrant;
  const tried = [...(same ? prev!.tried ?? [] : [])];
  // El escalón anterior falló con la misma huella → su resultado queda registrado.
  if (same && prev!.rung >= 1 && prev!.rung <= 2) tried.push({ rung: prev!.rung, at, outcome: 'failed_same_fingerprint' });
  if (action === 'exhausted') tried.push({ rung: 3, at, outcome: 'exhausted' });
  const state: RemediationState = {
    v: 1,
    fingerprint: fp,
    code: verdict.code,
    rule: verdict.rule,
    itemType: itemType ?? null,
    innerCodes: inner,
    count,
    rung,
    firstAt: same ? prev!.firstAt : at,
    lastAt: at,
    findings,
    feedback: rung >= 1 ? feedbackFor(verdict.code, inner, findings, rung >= 2 ? 2 : 1) : null,
    // r99: nunca se acepta una salida inválida (DEGRADABLE_CODES vacío).
    acceptCodes: [],
    grants: grantsUsed + (grant ? 1 : 0),
    grantsTotal: grantsTotalUsed + (grant ? 1 : 0),
    tried: tried.slice(-10),
    sampleError: redactErrorExcerpt(error),
    ...(action === 'exhausted' ? { exhaustedError: String(error ?? '').slice(0, 500), exhaustedAt: at } : {}),
    ...(previous.length ? { previous } : {}),
  };
  return { state, action, grant };
}

/**
 * Review P1-3: un reintento HUMANO (dueño / admin) abre un ciclo nuevo de la escalera: count=1 (el próximo fallo igual
 * vuelve a rung 1, con intento extra si el tope de la parte lo permite, y después rung 2), sin la marca de agotada; el
 * feedback (el próximo intento ya lleva el pedido corregido), `previous` y `grantsTotal` se conservan.
 */
export function resetRemediationForManualRetry(prev: RemediationState | null, now: Date = new Date()): RemediationState | null {
  if (!prev || prev.outcome) return prev;
  return {
    ...prev,
    count: 1,
    rung: prev.feedback ? 1 : 0,
    acceptCodes: [],
    grants: 0,
    grantsTotal: Math.max(Number(prev.grantsTotal ?? 0) || 0, Number(prev.grants ?? 0) || 0),
    exhaustedError: null,
    exhaustedAt: null,
    manualResetAt: now.toISOString(),
    tried: [...(prev.tried ?? []), { rung: prev.rung, at: now.toISOString(), outcome: 'manual_retry' }].slice(-10),
  };
}

/** rung 3 vigente para ESTE error: ningún barrido automático lo reabre (el dueño sí, a mano). */
export function remediationBlocksAuto(os: Record<string, any> | null | undefined, error: string | null | undefined): boolean {
  const r = remediationOf(os);
  return !!r && r.rung === 3 && !r.outcome && typeof r.exhaustedError === 'string' && r.exhaustedError === String(error ?? '').slice(0, 500);
}

/** Códigos que el intento ACTUAL puede aceptar con marca de calidad (rung 2 vigente). */
export function acceptCodesOf(os: Record<string, any> | null | undefined): Set<string> {
  const r = remediationOf(os);
  if (!r || r.outcome || r.rung !== 2) return new Set();
  return new Set((r.acceptCodes ?? []).filter((c) => DEGRADABLE_CODES.includes(c)));
}

/** Feedback para el prompt del intento actual (rung ≥ 1 sin completar), o null. */
export function remediationFeedbackOf(os: Record<string, any> | null | undefined): string | null {
  const r = remediationOf(os);
  if (!r || r.outcome || r.rung < 1 || typeof r.feedback !== 'string' || !r.feedback.trim()) return null;
  return r.feedback.slice(0, REMEDIATION_FEEDBACK_MAX);
}

/** Marca de calidad de una aceptación de rung 2 (output_summary.quality.warnings[]). */
export function qualityAcceptance(codes: readonly string[], findings: readonly string[], now: Date, fingerprint: string | null): Record<string, any> {
  return { code: 'quality_accepted', codes: [...codes], findings: findings.slice(0, REMEDIATION_FINDINGS_MAX).map((f) => String(redactErrorExcerpt(f) ?? '').slice(0, 160)), fingerprint, rung: 2, at: now.toISOString() };
}

/** output_summary.quality con la marca nueva agregada (acotado a 20). */
export function withQualityWarning(prev: unknown, w: Record<string, any>): Record<string, any> {
  const q = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...(prev as Record<string, any>) } : {};
  const ws = Array.isArray(q.warnings) ? [...q.warnings] : [];
  ws.push(w);
  return { ...q, degraded: true, warnings: ws.slice(-20) };
}

// ─── Señal sistémica «Falla común» (agregada, no por curso) ─────────────────

export const COMMON_FAILURE_MIN_COURSES = 3;
/** r99: una parte en PAUSA COMO BUG DE CURSIA (bug-hold.ts) se reporta desde el PRIMER curso. */
export const COMMON_FAILURE_BUG_HOLD_MIN_COURSES = 1;
export const COMMON_FAILURE_WINDOW_HOURS = 24;
export const COMMON_FAILURE_QUIET_HOURS = 72;

export interface CommonFailureRow {
  courseId: number;
  /**
   * r99 (review P2-9): identidad del CURSO para contar cursos distintos — el `frontend_course_id` (UUID) del run; el
   * numérico `course_id` se reutiliza entre generaciones de cursos distintos. Ausente → String(courseId).
   */
  courseKey?: string | null;
  runId: string;
  itemKey: string;
  itemType: string | null;
  remediation?: RemediationState | null;
  /** r99: pausa como bug de Cursia (output_summary.bugHold) de la parte, vigente o reanudada. */
  bugHold?: BugHoldState | null;
}

export interface CommonFailureSignal {
  fingerprint: string;
  code: string;
  rule: string;
  itemType: string | null;
  /** r99: 'bug_hold' = partes en pausa esperando un arreglo (umbral 1); 'repeated' = misma falla repetida (≥ 3 cursos). */
  kind: 'bug_hold' | 'repeated';
  firstSeen: string;
  lastSeen: string;
  courses: number[];
  /** r99 (P2-9): identidades de curso (frontend_course_id) contadas. */
  courseKeys: string[];
  runs: string[];
  /** Cursos distintos dentro de la mejor ventana de 24 h (por courseKey). */
  coursesInWindow: number;
  /** r99: partes en pausa vigente (esperando el arreglo) con esta huella. */
  heldItems: number;
  samples: Array<{ error: string | null; findings: string[] }>;
  rungs: Array<{ rung: number; outcome: string; count: number }>;
  source: { file: string; fn: string; hint: string } | null;
  status: 'active' | 'resolved';
  resolvedBy: 'admin' | 'quiet_72h' | 'resumed' | null;
  resolvedAt: string | null;
  report: string;
}

/** Texto para el reporte: sin secretos (redactErrorExcerpt) y sin emails (solo ids en el reporte). */
export function sanitizeForReport(v: unknown, max = 300): string {
  return String(redactErrorExcerpt(v) ?? '')
    .replace(/\b((?:access_|refresh_|id_)?token|key|secret|password|signature)\s*[:=]\s*[^\s"',;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/\s+/g, ' ').slice(0, max);
}

const ms = (s: string | null | undefined) => { const t = Date.parse(String(s ?? '')); return Number.isFinite(t) ? t : NaN; };
const courseKeyOf = (r: CommonFailureRow) => String(r.courseKey ?? '').trim() || String(r.courseId);

interface Occ { row: CommonFailureRow; fp: string; code: string; rule: string; itemType: string | null; innerCodes: string[]; firstAt: number; lastAt: number;
  sampleError: string | null; findings: string[]; rung: number; outcome: string; held: boolean }

function occurrenceOf(r: CommonFailureRow): Occ | null {
  const b = r.bugHold;
  if (b && typeof b.fingerprint === 'string' && Number.isFinite(ms(b.lastAt))) {
    const rem = r.remediation;
    return {
      row: r, fp: b.fingerprint, code: b.code, rule: b.rule, itemType: b.itemType ?? r.itemType ?? null, innerCodes: rem?.innerCodes ?? [],
      firstAt: ms(b.heldAt), lastAt: ms(b.lastAt), sampleError: b.sampleError ?? null, findings: rem?.findings ?? [],
      rung: rem?.rung ?? 3,
      outcome: b.reportOnly ? 'reportado (sigue con sus intentos propios)' : b.active ? `en pausa (${b.reason})` : `reanudada (${b.resumeTrigger ?? 'manual'})`,
      held: b.active === true,
    };
  }
  const rem = r.remediation;
  if (!rem || typeof rem.fingerprint !== 'string' || !Number.isFinite(ms(rem.lastAt))) return null;
  // Review P2-3: un fallo único no es «la misma falla repetida»: solo cuenta lo que se repitió en la parte.
  if (!(Number(rem.count) >= 2 || Number(rem.rung) >= 2 || (rem.tried ?? []).length > 0)) return null;
  const outcome = rem.outcome ? (rem.outcome === 'accepted' ? 'aceptado con marca de calidad (r98, retirado)' : 'completado tras corregir el pedido')
    : rem.rung === 3 ? 'agotado (falló igual)' : rem.rung === 2 ? 'reescritura pendiente' : rem.rung === 1 ? 'reintento con correcciones pendiente' : 'observando';
  return {
    row: r, fp: rem.fingerprint, code: rem.code, rule: rem.rule, itemType: rem.itemType ?? r.itemType ?? null, innerCodes: rem.innerCodes ?? [],
    firstAt: ms(rem.firstAt), lastAt: ms(rem.lastAt), sampleError: rem.sampleError ?? null, findings: rem.findings ?? [], rung: rem.rung, outcome, held: false,
  };
}

/**
 * Agrupa por huella. Dos tipos de señal:
 *  - `bug_hold` (r99): partes en PAUSA COMO BUG DE CURSIA — se reporta desde el PRIMER curso; activa mientras quede
 *    alguna parte en pausa (nunca se «resuelve» sola por silencio: las partes esperan el arreglo); resuelta cuando todas
 *    se reanudaron o un admin la marcó resuelta después de la última aparición (eso también reanuda las partes);
 *  - `repeated` (r98): la misma falla determinista en ≥ 3 cursos distintos dentro de 24 h; resuelta por un admin o tras
 *    72 h sin aparecer.
 * Los cursos se cuentan por `courseKey` (frontend_course_id, review P2-9), nunca por el numérico solo.
 */
export function commonFailureSignals(rows: readonly CommonFailureRow[], resolutions: ReadonlyMap<string, string>, now: Date = new Date()): CommonFailureSignal[] {
  const by = new Map<string, Occ[]>();
  for (const r of rows) {
    const o = occurrenceOf(r);
    if (!o) continue;
    by.set(o.fp, [...(by.get(o.fp) ?? []), o]);
  }
  const out: CommonFailureSignal[] = [];
  const windowMs = COMMON_FAILURE_WINDOW_HOURS * 3_600_000;
  for (const [fp, list] of by) {
    const isHold = list.some((o) => o.row.bugHold && o.row.bugHold.fingerprint === fp);
    const occ = list.map((o) => ({ c: courseKeyOf(o.row), t: o.lastAt })).sort((a, b) => a.t - b.t);
    let best = 0;
    for (let i = 0; i < occ.length; i++) {
      const set = new Set<string>();
      for (let j = i; j < occ.length && occ[j].t - occ[i].t <= windowMs; j++) set.add(occ[j].c);
      best = Math.max(best, set.size);
    }
    if (best < (isHold ? COMMON_FAILURE_BUG_HOLD_MIN_COURSES : COMMON_FAILURE_MIN_COURSES)) continue;
    const first = Math.min(...list.map((o) => o.firstAt).filter(Number.isFinite));
    const last = Math.max(...occ.map((o) => o.t));
    const head = list[0];
    const rungMap = new Map<string, { rung: number; outcome: string; count: number }>();
    for (const o of list) {
      const k = `${o.rung}|${o.outcome}`;
      const e = rungMap.get(k) ?? { rung: o.rung, outcome: o.outcome, count: 0 };
      e.count++;
      rungMap.set(k, e);
    }
    const held = list.filter((o) => o.held).length;
    const resolvedAdmin = resolutions.get(fp) ?? null;
    const adminOk = !!resolvedAdmin && ms(resolvedAdmin) >= last;
    const quiet = !isHold && now.getTime() - last > COMMON_FAILURE_QUIET_HOURS * 3_600_000;
    // Review P1-1: un reporte sin pausa (código sin regla que todavía usa sus intentos) mantiene la señal activa 72 h.
    const reportedRecent = list.some((o) => o.row.bugHold?.reportOnly && now.getTime() - o.lastAt <= COMMON_FAILURE_QUIET_HOURS * 3_600_000);
    const allResumed = isHold && held === 0 && !reportedRecent;
    const status: CommonFailureSignal['status'] = adminOk || quiet || allResumed ? 'resolved' : 'active';
    const lastResume = Math.max(...list.map((o) => ms(o.row.bugHold?.resumedAt ?? null)).filter(Number.isFinite), NaN);
    const sig: CommonFailureSignal = {
      fingerprint: fp,
      code: head.code,
      rule: head.rule,
      itemType: head.itemType,
      kind: isHold ? 'bug_hold' : 'repeated',
      firstSeen: new Date(Number.isFinite(first) ? first : occ[0].t).toISOString(),
      lastSeen: new Date(last).toISOString(),
      courses: [...new Set(list.map((o) => o.row.courseId))].sort((a, b) => a - b),
      courseKeys: [...new Set(list.map((o) => courseKeyOf(o.row)))].sort(),
      runs: [...new Set(list.map((o) => o.row.runId))],
      coursesInWindow: best,
      heldItems: held,
      samples: list.slice(-3).map((o) => ({ error: o.sampleError ? sanitizeForReport(o.sampleError) : null, findings: (o.findings ?? []).slice(0, 5).map((f) => sanitizeForReport(f, 160)) })),
      rungs: [...rungMap.values()].sort((a, b) => a.rung - b.rung),
      source: FAILURE_CODE_SOURCES[head.code] ?? (head.innerCodes ?? []).map((c) => FAILURE_CODE_SOURCES[c]).find(Boolean) ?? null,
      status,
      resolvedBy: adminOk ? 'admin' : allResumed ? 'resumed' : quiet ? 'quiet_72h' : null,
      resolvedAt: adminOk ? resolvedAdmin : allResumed ? (Number.isFinite(lastResume) ? new Date(lastResume).toISOString() : new Date(last).toISOString())
        : quiet ? new Date(last + COMMON_FAILURE_QUIET_HOURS * 3_600_000).toISOString() : null,
      report: '',
    };
    sig.report = commonFailureReport(sig);
    out.push(sig);
  }
  return out.sort((a, b) => ms(b.lastSeen) - ms(a.lastSeen));
}

/** Reporte listo para pegar en una sesión de desarrollo (Markdown). Solo ids; mensajes recortados y sin secretos. */
export function commonFailureReport(s: Omit<CommonFailureSignal, 'report'>): string {
  const L: string[] = [];
  if (s.kind === 'bug_hold') {
    L.push(`## Bug de Cursia (partes en pausa automática): ${s.heldItems} parte(s) esperando el arreglo de ${s.code}`);
    L.push('');
    L.push('- Las partes están pausadas sin gasto; se reanudan SOLAS al desplegar el arreglo (build nuevo), si el código pasa a tener una estrategia, o al marcar esta huella como resuelta.');
  } else {
    L.push(`## Falla común (bug probable): ${s.courseKeys.length} cursos con la misma falla ${s.code}`);
    L.push('');
  }
  L.push(`- Huella: \`${s.fingerprint}\``);
  L.push(`- Código: ${s.code} · validador/regla: ${s.rule} · tipo de parte: ${s.itemType ?? '-'}`);
  L.push(`- Visto por primera vez: ${s.firstSeen} · última vez: ${s.lastSeen}`);
  L.push(`- Cursos afectados (${s.courseKeys.length}; ${s.coursesInWindow} dentro de 24 h): ${s.courseKeys.join(', ')} (ids numéricos: ${s.courses.join(', ')})`);
  L.push(`- Runs: ${s.runs.join(', ')}`);
  L.push(`- Dónde se emite: ${s.source ? `src/${s.source.file} — ${s.source.fn}` : '(sin mapa: agregar el código a FAILURE_CODE_SOURCES en src/modules/reliability/failure-classifier.ts)'}`);
  if (s.rule === 'unclassified') {
    L.push('- El código NO tiene regla en el clasificador: agregar la regla en src/modules/reliability/failure-classifier.ts y su estrategia en src/modules/reliability/remediation-strategies.ts (las partes en pausa se reanudan solas con la estrategia nueva).');
  }
  L.push('- Escalones / estados probados:');
  for (const r of s.rungs) L.push(`  - rung ${r.rung}: ${r.outcome} (${r.count})`);
  L.push('- Ejemplos (recortados, sin secretos):');
  s.samples.forEach((x, i) => {
    L.push(`  ${i + 1}. ${sanitizeForReport(x.error ?? '')}`);
    if (x.findings.length) L.push(`     hallazgos: ${sanitizeForReport(x.findings.join(' · '))}`);
  });
  L.push(`- Punto de partida sugerido: ${s.source ? s.source.hint : `buscar dónde se emite ${s.code} (grep -rn "${s.code}" src) y por qué el mismo pedido falla igual`}.`);
  L.push(`- Estado: ${s.status === 'resolved' ? `resuelto (${s.resolvedBy === 'admin' ? 'marcado por un admin' : s.resolvedBy === 'resumed' ? 'todas las partes se reanudaron' : 'sin apariciones en 72 h'})` : 'activo'}`);
  return L.join('\n');
}
