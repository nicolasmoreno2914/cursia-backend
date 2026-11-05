// ─────────────────────────────────────────────────────────────────────────────
// r99 — PAUSA COMO BUG DE CURSIA («lo estamos resolviendo»), sin migración: output_summary.bugHold.
//
// Cuándo entra una parte (estado `failed`, sin intentos ni gasto mientras dura):
//  - desde la PRIMERA vez, si el veredicto no tiene estrategia automática (código sin regla del clasificador, contrato
//    roto, configuración de Cursia, D `hold_for_human` sin camino automático) → item-transitions.applyCursiaIssueHold;
//  - cuando la estrategia asignada se agotó (escalera de remediación agotada, ventana de la clase A agotada, conciliación
//    declinada, ronda extra del tope de la parte usada, parte sin estrategias) → el barrido RunsService.sweepCursiaIssues.
// Lo que NO es un bug (pausa del usuario, presupuesto autorizado del run, acceso de la cuenta) nunca entra.
//
// Qué ve el usuario: CURSIA_ISSUE_MESSAGE (sin «reintentar»: el curso continúa solo).
// Qué ve desarrollo: «Falla común» con umbral 1 (admin-recovery.service.ts), reporte con huella, muestras y dónde se emite.
//
// Reanudación AUTOMÁTICA (barrido periódico; el primero corre al arrancar el proceso = después de cada deploy):
//  - `reclassified`: con el clasificador / la tabla de estrategias VIGENTES el error ya tiene una estrategia automática
//    (o la huella cambió) → se reabre con esa estrategia;
//  - `resolved`: desarrollo marcó la huella como resuelta en «Falla común» DESPUÉS de la pausa;
//  - `new_build`: el código desplegado cambió desde la pausa (otro build) → UNA reapertura por build, hasta
//    BUG_HOLD_MAX_BUILD_RESUMES por parte. Nunca con pago incierto (solo reclassified / resolved).
// Toda reapertura va por RunsService.retryItem (auto): mismos locks y guards de FinOps (presupuesto de la parte, tope y
// autorización del run). Si vuelve a fallar con la misma huella, vuelve a la pausa (sin rehacer la escalera).
// Puro salvo el reloj y la identidad del build (currentBuildId: lectura de archivos, cacheada).
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { FailureVerdict } from './failure-classifier';
import { redactErrorExcerpt } from './attempt-log';
import { RemediationStrategyId, STRATEGY_CATALOG, isCursiaIssueStrategy, remediationStrategyFor } from './remediation-strategies';

export const BUG_HOLD_KEY = 'bugHold';
/** Marca «resuelto» de una huella en «Falla común» (admin_audit_log; la escribe admin-recovery.service.ts). */
export const BUG_HOLD_RESOLVE_ACTION = 'common_failure.resolve';
export const BUG_HOLD_RESOLVE_TARGET_TYPE = 'failure_fingerprint';
/**
 * Espera antes de pausar una parte desde el barrido (los demás barridos del tick tienen su oportunidad primero). Review
 * P2-1: ≥ la espera de la reapertura de IA en revisión (LLM_REVIEW_REOPEN_DELAY_SECONDS = 720) con margen.
 */
export const BUG_HOLD_SWEEP_GRACE_SECONDS = 900;
/** Review P2-2: espera mínima entre dos reanudaciones AUTOMÁTICAS de la misma parte (reclasificada / build nuevo). */
export const BUG_HOLD_RESUME_MIN_INTERVAL_SECONDS = 1800;
/** Decisión del dueño pendiente (tope de reanudaciones): env R99_BUG_HOLD_MAX_RESUMES (default 3, rango 0…20). */
export const BUG_HOLD_MAX_RESUMES_ENV = 'R99_BUG_HOLD_MAX_RESUMES';
/** Enfriamiento tras una reanudación rechazada por retryItem (presupuesto, run pausado, otro run activo…). */
export const BUG_HOLD_RESUME_COOLDOWN_SECONDS = 1800;
/** Estado de recuperación expuesto (recovery-state.ts) mientras la parte está en pausa por un bug de Cursia. */
export const CURSIA_ISSUE_STATE = 'paused_cursia_issue';
/** Mensaje para el creador del curso (sin «reintentar»: no es su problema). */
export const CURSIA_ISSUE_MESSAGE = 'Encontramos un problema de nuestro lado y lo estamos resolviendo. No tienes que hacer nada; tu curso continuará automáticamente.';
/** Reaperturas AUTOMÁTICAS (build nuevo + reclasificada) por parte, por defecto (cada una pasa por los guards de FinOps). */
export const BUG_HOLD_MAX_BUILD_RESUMES = 3;

export function bugHoldMaxResumes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(String(env[BUG_HOLD_MAX_RESUMES_ENV] ?? '').trim());
  return String(env[BUG_HOLD_MAX_RESUMES_ENV] ?? '').trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 20 ? n : BUG_HOLD_MAX_BUILD_RESUMES;
}
/** Ventana del barrido: una pausa más vieja que esto ya no se reabre sola por build (sí por reclasificación / resuelto). */
export const BUG_HOLD_MAX_AGE_DAYS = 14;
/**
 * Corte de activación: runs creados antes NO entran a la pausa (ni la inmediata ni la del barrido; los datos históricos no
 * se tocan). r99 (decisión del dueño 4): por defecto MÓVIL = ahora − 30 días (los fallidos del último mes entran al flujo
 * de pausa / reanudación); R99_BUG_HOLD_SINCE (ISO) lo fija.
 */
export const BUG_HOLD_SINCE_ENV = 'R99_BUG_HOLD_SINCE';
export const BUG_HOLD_DEFAULT_SINCE_DAYS = 30;
export const BUG_HOLD_HISTORY_MAX = 10;
export const BUG_HOLD_ERROR_MAX = 500;

export type BugHoldReason =
  | 'unmapped_code' // ninguna regla del clasificador / de la tabla de estrategias
  | 'product_bug' // contrato roto / producto (D)
  | 'config' // configuración de Cursia (proveedor, modelo, YouTube del canal de Cursia…)
  | 'strategy_exhausted' // la estrategia asignada se agotó (escalera, ventana A, rondas, sin estrategias)
  | 'reconcile_pending' // pago incierto sin conciliación automática que lo tome
  | 'item_budget_exhausted'; // la ronda extra del tope de la parte ya se usó

export type BugHoldResumeTrigger = 'reclassified' | 'resolved' | 'new_build' | 'reprobe';

/**
 * Re-review: una pausa cuya estrategia esperaba una condición EXTERNA (proveedor caído > 6 h, cuota…) no espera al
 * próximo deploy: cada BUG_HOLD_REPROBE_INTERVAL_SECONDS se vuelve a sondear (USD 0; con la sonda de salud del proveedor
 * cuando existe) y, si responde, se reabre (esa reapertura sí cuenta en el tope por parte). ≤ BUG_HOLD_REPROBE_MAX_PER_DAY.
 */
export const BUG_HOLD_REPROBE_INTERVAL_SECONDS = 2 * 3600;
export const BUG_HOLD_REPROBE_MAX_PER_DAY = 12;

export interface BugHoldState {
  v: 1;
  active: boolean;
  reason: BugHoldReason;
  code: string;
  rule: string;
  /** Huella para «Falla común»: tipo + código + regla + firma del mensaje (sin cifras / ids). */
  fingerprint: string;
  itemType: string | null;
  /** Error exacto (≤ 500) que dejó la pausa: la pausa vale SOLO para ese error. */
  error: string;
  /** Muestra para el reporte (recortada y sin secretos). */
  sampleError: string | null;
  heldAt: string;
  lastAt: string;
  /** Veces que la parte cayó en pausa (con cualquier huella). */
  count: number;
  /** Build vigente al pausar (la reanudación por build compara contra este). */
  buildId: string;
  /** Reaperturas automáticas ya hechas por build nuevo. */
  buildResumes: number;
  /** Review P2-2: reaperturas AUTOMÁTICAS totales (build nuevo + reclasificada); tope bugHoldMaxResumes(). */
  autoResumes?: number;
  /** Review P2-2: última reapertura automática (enfriamiento entre reaperturas). */
  lastResumeAt?: string | null;
  /**
   * Review P1-1: solo REPORTE (no pausa): un código sin regla que el emisor marcó reintentable y todavía tiene intentos
   * propios — los usa con su backoff; «Falla común» lo ve desde la primera vez. Si se agotan, recién ahí la pausa.
   */
  reportOnly?: boolean;
  /** Re-review: fallo ORIGINAL (la ventana de 14 días y el backfill cuentan desde acá, no desde la pausa). */
  originalFailedAt?: string | null;
  /** Re-review: sondas de una pausa por condición externa (USD 0; no cuentan en el tope si no despachan). */
  lastProbeAt?: string | null;
  probes?: { day: string; n: number } | null;
  /** Pago incierto: solo reclassified / resolved (nunca por build). */
  paidUncertain: boolean;
  /** Estrategia que tenía el veredicto al pausar (auditoría). */
  strategy: RemediationStrategyId | string;
  resumedAt?: string | null;
  resumedBy?: string | null;
  resumeTrigger?: BugHoldResumeTrigger | null;
  history: Array<{ at: string; event: 'held' | 'resumed'; reason?: string; trigger?: string; buildId?: string; by?: string }>;
}

export function bugHoldStateOf(os: Record<string, any> | null | undefined): BugHoldState | null {
  const b = os?.[BUG_HOLD_KEY];
  return b && typeof b === 'object' && typeof b.fingerprint === 'string' && typeof b.error === 'string' ? (b as BugHoldState) : null;
}

/** Pausa VIGENTE para este error (null = sin pausa, reanudada o la parte ya falló con otro error). */
export function bugHoldOf(os: Record<string, any> | null | undefined, error: string | null | undefined): BugHoldState | null {
  const b = bugHoldStateOf(os);
  if (!b || b.active !== true) return null;
  return b.error === String(error ?? '').slice(0, BUG_HOLD_ERROR_MAX) ? b : null;
}

/** Firma estable de un mensaje libre: minúsculas, sin cifras/uuids/ids/comillas, primeras palabras. */
export function messageSignature(error: string): string {
  return String(error ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/«[^»]*»|"[^"]*"|'[^']*'/g, '<q>')
    .replace(/\d+(?:[.,]\d+)?/g, '<n>')
    .replace(/[^a-z_<>:\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ')
    .slice(0, 80);
}

export function bugHoldFingerprint(v: Pick<FailureVerdict, 'code' | 'rule' | 'innerCodes'> & { unclassified?: boolean }, itemType: string | null | undefined, error: string): string {
  const inner = [...new Set((v.innerCodes ?? []).map(String))].sort().join(',');
  // Sin regla, el código suele ser `unclassified_error` (texto libre): la firma del mensaje separa causas distintas.
  const sig = v.unclassified ? messageSignature(error) : '';
  return ['hold', String(itemType ?? '-'), v.code, v.rule, inner, sig].join('|').slice(0, 200);
}

/** ¿El veredicto pausa la parte YA (primera vez), sin esperar a otra estrategia? */
export function holdsImmediately(v: FailureVerdict): { hold: boolean; reason: BugHoldReason | null; strategy: RemediationStrategyId } {
  const s = remediationStrategyFor(v);
  if (!isCursiaIssueStrategy(s.strategy) || v.scope === 'package') return { hold: false, reason: null, strategy: s.strategy };
  const reason: BugHoldReason = s.source === 'unmapped' ? 'unmapped_code'
    : v.paidRisk === 'uncertain' || v.humanReason === 'duplicate_charge' ? 'reconcile_pending'
      : v.humanReason === 'config' ? 'config' : 'product_bug';
  return { hold: true, reason, strategy: s.strategy };
}

export function nextBugHold(
  prev: BugHoldState | null,
  v: FailureVerdict,
  itemType: string | null | undefined,
  error: string,
  reason: BugHoldReason,
  now: Date,
  buildId: string,
  /** Fallo original (finished_at de la fila); default: ahora. Se conserva entre pausas de la misma parte. */
  failedAt?: Date | string | null,
): BugHoldState {
  const at = now.toISOString();
  const strategy = remediationStrategyFor(v).strategy;
  const fa = failedAt ? new Date(failedAt as any) : now;
  const history = [...(prev?.history ?? []), { at, event: 'held' as const, reason, buildId }].slice(-BUG_HOLD_HISTORY_MAX);
  return {
    v: 1,
    active: true,
    reason,
    code: v.code,
    rule: v.rule,
    fingerprint: bugHoldFingerprint(v, itemType, error),
    itemType: itemType ?? null,
    error: String(error ?? '').slice(0, BUG_HOLD_ERROR_MAX),
    sampleError: redactErrorExcerpt(error),
    heldAt: at,
    lastAt: at,
    count: Math.max(0, Math.floor(Number(prev?.count ?? 0)) || 0) + 1,
    buildId,
    // Las reaperturas se cuentan por PARTE (nunca se reinician: tope duro de gasto).
    buildResumes: Math.max(0, Math.floor(Number(prev?.buildResumes ?? 0)) || 0),
    autoResumes: Math.max(0, Math.floor(Number(prev?.autoResumes ?? prev?.buildResumes ?? 0)) || 0),
    originalFailedAt: prev?.originalFailedAt ?? (Number.isFinite(fa.getTime()) ? fa.toISOString() : at),
    lastProbeAt: prev?.lastProbeAt ?? null,
    probes: prev?.probes ?? null,
    lastResumeAt: prev?.lastResumeAt ?? null,
    reportOnly: false,
    paidUncertain: v.paidRisk === 'uncertain' || v.humanReason === 'duplicate_charge' || reason === 'reconcile_pending',
    strategy,
    resumedAt: null,
    resumedBy: null,
    resumeTrigger: null,
    history,
  };
}

/**
 * Review P1-1: solo REPORTE de un código sin regla que todavía usa sus intentos propios (no pausa la parte). La huella y
 * la muestra quedan para «Falla común» desde la primera vez.
 */
export function reportedBugHold(prev: BugHoldState | null, v: FailureVerdict, itemType: string | null | undefined, error: string, now: Date, buildId: string): BugHoldState {
  return { ...nextBugHold(prev, v, itemType, error, 'unmapped_code', now, buildId), active: false, reportOnly: true };
}

/** Estado tras una reapertura (automática o humana): la pausa deja de estar vigente (el historial se conserva). */
export function resumedBugHold(prev: BugHoldState, now: Date, by: string, trigger: BugHoldResumeTrigger | null): BugHoldState {
  const at = now.toISOString();
  const automatic = trigger === 'new_build' || trigger === 'reclassified' || trigger === 'reprobe';
  return {
    ...prev,
    active: false,
    resumedAt: at,
    resumedBy: by,
    resumeTrigger: trigger,
    buildResumes: prev.buildResumes + (trigger === 'new_build' ? 1 : 0),
    autoResumes: Math.max(0, Math.floor(Number(prev.autoResumes ?? prev.buildResumes ?? 0)) || 0) + (automatic ? 1 : 0),
    lastResumeAt: automatic ? at : prev.lastResumeAt ?? null,
    history: [...(prev.history ?? []), { at, event: 'resumed' as const, ...(trigger ? { trigger } : {}), by }].slice(-BUG_HOLD_HISTORY_MAX),
  };
}

export type BugHoldResumeDecision =
  | { resume: true; trigger: BugHoldResumeTrigger; strategy: RemediationStrategyId }
  | { resume: false; reason: 'not_held' | 'still_unmapped' | 'waiting_fix' | 'build_resumes_exhausted' | 'paid_uncertain' | 'too_old' | 'cooldown' };

export interface BugHoldResumeCtx {
  now: Date;
  buildId: string;
  /** Fecha de la marca «resuelto» de desarrollo para la huella (admin_audit_log), o null. */
  resolvedAt?: string | null;
  /** Veredicto del error con el clasificador VIGENTE (lo calcula el caller con la fila). */
  verdict: FailureVerdict;
  itemType: string | null;
  /** Tope de reaperturas automáticas (default bugHoldMaxResumes()). */
  maxResumes?: number;
}

/**
 * ¿Se reanuda sola esta parte en pausa? Pura. `reclassified` gana (la estrategia nueva es la que corre), después
 * `resolved` y por último `new_build` (acotado, nunca con pago incierto).
 */
export function bugHoldResumeDecision(row: { status: string; error: string | null; output_summary: Record<string, any> | null }, ctx: BugHoldResumeCtx): BugHoldResumeDecision {
  if (row.status !== 'failed') return { resume: false, reason: 'not_held' };
  const hold = bugHoldOf(row.output_summary, row.error);
  if (!hold) return { resume: false, reason: 'not_held' };
  const now = ctx.now.getTime();
  const s = remediationStrategyFor(ctx.verdict);
  const max = ctx.maxResumes ?? bugHoldMaxResumes();
  const autoUsed = Math.max(0, Math.floor(Number(hold.autoResumes ?? hold.buildResumes ?? 0)) || 0);
  const lastAuto = hold.lastResumeAt ? Date.parse(hold.lastResumeAt) : NaN;
  const cooling = Number.isFinite(lastAuto) && now - lastAuto < BUG_HOLD_RESUME_MIN_INTERVAL_SECONDS * 1000;
  // Las reaperturas AUTOMÁTICAS (reclasificada / build nuevo) comparten tope y enfriamiento (review P2-2).
  const automaticGate = (): BugHoldResumeDecision | null => {
    if (hold.paidUncertain) return { resume: false, reason: 'paid_uncertain' };
    if (autoUsed >= max) return { resume: false, reason: 'build_resumes_exhausted' };
    // Re-review: la ventana cuenta desde el fallo ORIGINAL (un backfill no reinicia los 14 días).
    if (now - Date.parse(hold.originalFailedAt ?? hold.heldAt) > BUG_HOLD_MAX_AGE_DAYS * 86_400_000) return { resume: false, reason: 'too_old' };
    if (cooling) return { resume: false, reason: 'cooldown' };
    return null;
  };
  // 1) Reclasificada (review P2-2): SOLO si al pausar la estrategia era de bug de Cursia (hold.strategy) y con el código
  //    vigente ya no lo es. Una parte pausada con una estrategia automática que se agotó no «se reclasifica» sola.
  const heldAsBug = isCursiaIssueStrategy(String(hold.strategy) as RemediationStrategyId);
  if (heldAsBug && !isCursiaIssueStrategy(s.strategy) && s.strategy !== 'owner_decision') {
    const g = automaticGate();
    if (g) return g;
    return { resume: true, trigger: 'reclassified', strategy: s.strategy };
  }
  // 2) Desarrollo marcó la huella como resuelta después de la pausa (una reapertura por marca: fuera del tope automático).
  const resolved = ctx.resolvedAt ? Date.parse(ctx.resolvedAt) : NaN;
  if (Number.isFinite(resolved) && resolved >= Date.parse(hold.heldAt)) return { resume: true, trigger: 'resolved', strategy: s.strategy };
  // 3) Build nuevo desde la pausa: UNA reapertura por build, acotada; nunca con pago incierto ni pasada la ventana.
  if (ctx.buildId && hold.buildId && ctx.buildId !== hold.buildId) {
    const g = automaticGate();
    if (g) return g;
    return { resume: true, trigger: 'new_build', strategy: s.strategy };
  }
  // 4) Re-review: pausa por condición EXTERNA (la estrategia al pausar esperaba al proveedor / la red) → re-sonda cada
  //    2 h (≤ 12 por día). El barrido sondea (USD 0) y solo reabre si el proveedor responde.
  const external = STRATEGY_CATALOG[String(hold.strategy) as RemediationStrategyId]?.changes === 'external_condition';
  if (external) {
    const lastProbe = Math.max(Date.parse(hold.lastProbeAt ?? '') || 0, Date.parse(hold.heldAt) || 0, Number.isFinite(lastAuto) ? lastAuto : 0);
    const day = ctx.now.toISOString().slice(0, 10);
    const today = hold.probes && hold.probes.day === day ? hold.probes.n : 0;
    if (now - lastProbe >= BUG_HOLD_REPROBE_INTERVAL_SECONDS * 1000 && today < BUG_HOLD_REPROBE_MAX_PER_DAY) {
      const g = automaticGate();
      if (g) return g;
      return { resume: true, trigger: 'reprobe', strategy: String(hold.strategy) as RemediationStrategyId };
    }
  }
  return { resume: false, reason: hold.reason === 'unmapped_code' ? 'still_unmapped' : 'waiting_fix' };
}

export function bugHoldSince(env: Record<string, string | undefined> = process.env, now: Date = new Date()): Date {
  const rolling = new Date(now.getTime() - BUG_HOLD_DEFAULT_SINCE_DAYS * 86_400_000);
  const raw = String(env[BUG_HOLD_SINCE_ENV] ?? '').trim();
  const d = raw ? new Date(raw) : rolling;
  return Number.isFinite(d.getTime()) ? d : rolling;
}

let cachedBuildId: string | null = null;

/**
 * Identidad del código desplegado: CURSIA_BUILD_ID si está, si no un hash del build compilado (nombre, tamaño y mtime de
 * main.js y de los módulos de confiabilidad / generación). Cambia en cada deploy (el CI compila de nuevo). Cacheada.
 */
export function currentBuildId(env: Record<string, string | undefined> = process.env): string {
  // Review: el SHA DESPLEGADO primero (CURSIA_BUILD_ID / DEPLOY_SHA / CFG_DEPLOY_SHA o el .release-sha que escribe
  // scripts/ops/prod-release.sh); sin él, el hash de mtimes del build compilado.
  for (const k of ['CURSIA_BUILD_ID', 'DEPLOY_SHA', 'CFG_DEPLOY_SHA']) {
    const explicit = String(env[k] ?? '').trim();
    if (explicit) return explicit.slice(0, 64);
  }
  if (cachedBuildId) return cachedBuildId;
  try {
    const sha = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '.release-sha'), 'utf8').trim();
    if (/^[0-9a-f]{7,40}$/.test(sha)) { cachedBuildId = sha.slice(0, 40); return cachedBuildId; }
  } catch {
    // sin .release-sha (staging / local): hash del build compilado.
  }
  const h = crypto.createHash('sha256');
  try {
    const root = path.resolve(__dirname, '..', '..');
    const files = [path.join(root, 'main.js')];
    for (const d of ['modules/reliability', 'modules/dynamic-generation', 'workers']) {
      const dir = path.join(root, d);
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
    for (const f of files) {
      try {
        const st = fs.statSync(f);
        h.update(`${path.relative(root, f)}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      } catch {
        h.update(`${f}:missing\n`);
      }
    }
  } catch {
    h.update('unknown');
  }
  cachedBuildId = h.digest('hex').slice(0, 16);
  return cachedBuildId;
}

/** Solo tests: olvida el build cacheado. */
/** Re-review: una sonda hecha (USD 0) que NO reabrió la parte: solo se anota (no cuenta en el tope). */
export function probedBugHold(prev: BugHoldState, now: Date): BugHoldState {
  const day = now.toISOString().slice(0, 10);
  const n = prev.probes && prev.probes.day === day ? prev.probes.n : 0;
  return { ...prev, lastProbeAt: now.toISOString(), probes: { day, n: n + 1 } };
}

export function resetBuildIdCache(): void {
  cachedBuildId = null;
}
