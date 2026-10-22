// ─────────────────────────────────────────────────────────────────────────────
// r67 (A3) — máquina de estados de RECUPERACIÓN de una parte (sin migración: columnas existentes + output_summary).
//
// Estados (output_summary.recovery.state):
//   completed                        la parte terminó;
//   transient_failed                 `retrying`: el scheduler la vuelve a tomar en next_retry_at (backoff interno);
//   pending_retry                    `failed` (o reabierta) con una estrategia automática SEGURA pendiente
//                                    (auto-heal A/B, reintento seguro, reenvío único de audio, control de gasto…);
//                                    next_retry_at = cuándo la toma el barrido (visible);
//   waiting_external_quota           espera una condición EXTERNA verificable (cuota de YouTube, sonda del proveedor);
//   waiting_financial_reconciliation hay un pago incierto: la conciliación (automática o humana) decide antes de
//                                    cualquier llamada nueva;
//   blocked_permanent                en manos de un humano por presupuesto / configuración / bug de producto;
//   failed_no_strategies             no queda ninguna estrategia automática segura (o expiró la espera): humano,
//                                    attention_reason='unrecoverable'.
//
// Invariante (r67, «sin huérfanos»): toda parte `failed` tiene next_retry_at (el sistema la va a retomar) o
// attention_reason (un humano la tiene que ver). Puro salvo el reloj y el env (políticas vigentes).
// ─────────────────────────────────────────────────────────────────────────────
import {
  ambiguousAudioResubmitDecision,
  autoHealDecision,
  autoHealPolicyFromEnv,
  autoRecoveryEnabled,
  safeAutoRetryDecision,
} from '../dynamic-generation/auto-heal';
import { providerReconcileDecision } from '../dynamic-generation/provider-reconcile';
import { classifyFailure, currentRecoveryOf, FailureSource } from './failure-classifier';
import { providerProbeViewOf } from './provider-probe';
import { CLAIM_PAYLOAD_DEPENDENCY_RE } from './claim-payload-recovery';

export type RecoveryState =
  | 'completed'
  | 'transient_failed'
  | 'pending_retry'
  | 'waiting_external_quota'
  | 'waiting_financial_reconciliation'
  | 'blocked_permanent'
  | 'failed_no_strategies';

export const RECOVERY_STATES: readonly RecoveryState[] = Object.freeze([
  'completed', 'transient_failed', 'pending_retry', 'waiting_external_quota', 'waiting_financial_reconciliation', 'blocked_permanent', 'failed_no_strategies',
] as RecoveryState[]);

/** Estados en los que el SISTEMA todavía va a hacer algo solo (el run no es «definitivamente fallido»). */
export const AUTOMATIC_RECOVERY_STATES: readonly RecoveryState[] = Object.freeze(['transient_failed', 'pending_retry', 'waiting_external_quota'] as RecoveryState[]);
// (waiting_financial_reconciliation es automático solo cuando un barrido de conciliación la va a tomar: ver `automatic`.)

export interface RecoveryStateView {
  /** null = parte sin fallo ni recuperación (pendiente/ejecutando por primera vez). */
  state: RecoveryState | null;
  /** Motivo corto (código / mecanismo). */
  reason: string | null;
  /** Próxima acción automática (ISO) o null. */
  nextRetryAt: string | null;
  /** ¿El sistema la va a retomar solo? */
  automatic: boolean;
}

export interface RecoveryRow {
  id?: string | null;
  type?: string | null;
  status: string;
  error?: string | null;
  output_summary?: Record<string, any> | null;
  finished_at?: Date | string | null;
  updated_at?: Date | string | null;
  next_retry_at?: Date | string | null;
  failure_class?: string | null;
  attention_reason?: string | null;
  recovery_round?: number | null;
  /** r67 (F6): creación del run (corte de los automatismos de r67). */
  run_created_at?: Date | string | null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function sourceOf(type: string | null | undefined): FailureSource | null {
  if (!type) return null;
  if (type === 'video') return 'video_worker';
  return ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(type) ? 'provider_worker' : 'browser_executor';
}

/** ¿Espera de cuota de YouTube (r62/DN-1: blockYoutubeQuota)? */
function youtubeQuotaWait(os: Record<string, any>, now: Date): Date | null {
  const until = toDate(os?.youtubeQuotaBlockedUntil ?? null) ?? toDate(os?.youtubeChannelLimitUntil ?? null);
  if (os?.delivery === 'blocked_quota' || (until && until.getTime() > now.getTime())) return until;
  return null;
}

/**
 * Próxima acción automática de una parte `failed` (la más cercana de los barridos que la tomarían), o null si
 * ninguno la va a tomar. Sin ledger (como la vista): el barrido re-evalúa todo bajo lock al actuar.
 */
export function scheduledRetryAtOf(row: RecoveryRow, now: Date = new Date()): Date | null {
  if (row.status !== 'failed') return null;
  const r = {
    id: row.id ?? null, type: row.type ?? null, status: row.status, error: row.error ?? null, output_summary: row.output_summary ?? {},
    finished_at: row.finished_at ?? null, updated_at: row.updated_at ?? null, failure_class: row.failure_class ?? null,
    run_created_at: row.run_created_at ?? null,
  };
  const policy = autoHealPolicyFromEnv(process.env);
  const times: Date[] = [];
  const add = (d: { heal: boolean; reason?: string; retryAt?: Date }) => {
    if (d.heal) times.push(now);
    else if (d.reason === 'backoff' && d.retryAt) times.push(d.retryAt);
  };
  add(autoHealDecision(r, now, policy) as any);
  add(safeAutoRetryDecision(r, now, policy) as any);
  add(ambiguousAudioResubmitDecision(r, now, undefined, policy) as any);
  add(providerReconcileDecision(r as any, now, policy) as any);
  const probe = providerProbeViewOf(r as any, now, autoRecoveryEnabled(process.env));
  if (probe) times.push(probe.nextProbeAt);
  if (!times.length) return null;
  return new Date(Math.min(...times.map((t) => t.getTime())));
}

/** r67: estado de recuperación DERIVADO de la fila (pura salvo reloj/env). */
export function recoveryStateOf(row: RecoveryRow, now: Date = new Date()): RecoveryStateView {
  const os = (row.output_summary ?? {}) as Record<string, any>;
  const status = String(row.status ?? '');
  const error = String(row.error ?? '').trim();
  const next = toDate(row.next_retry_at ?? null);
  if (status === 'completed') return { state: 'completed', reason: null, nextRetryAt: null, automatic: false };
  if (status === 'retrying') {
    const quota = youtubeQuotaWait(os, now);
    if (quota) return { state: 'waiting_external_quota', reason: os.youtubeQuotaScope === 'channel' ? 'youtube_channel_limit' : 'youtube_quota', nextRetryAt: iso(next ?? quota), automatic: true };
    // r67 (B4): blocked_auth no definitivo → espera la sonda automática (5 min / 30 min / 2 h), condición externa verificable.
    if (os.delivery === 'blocked_auth' && os.youtubeAuthProbe) {
      return { state: 'waiting_external_quota', reason: 'youtube_auth_probe', nextRetryAt: iso(next ?? toDate(os.youtubeAuthProbe?.nextProbeAt ?? null)), automatic: true };
    }
    return { state: 'transient_failed', reason: error ? error.split(':')[0].slice(0, 64) : null, nextRetryAt: iso(next), automatic: true };
  }
  if (status === 'pending' || status === 'running') {
    const reopened = Number(row.recovery_round ?? 0) > 0 || !!os.recovery || !!row.failure_class;
    return reopened
      ? { state: 'pending_retry', reason: String(os.recovery?.reason ?? 'reopened').slice(0, 64), nextRetryAt: null, automatic: true }
      : { state: null, reason: null, nextRetryAt: null, automatic: true };
  }
  if (status === 'blocked') {
    if (/^budget_exceeded/.test(error)) return { state: 'blocked_permanent', reason: 'budget', nextRetryAt: null, automatic: false };
    // Bloqueado por una dependencia: sigue a su dependencia (el run lo resuelve, ver runRecoveryStateOf).
    return { state: 'pending_retry', reason: 'dependency_blocked', nextRetryAt: null, automatic: true };
  }
  if (status !== 'failed') return { state: null, reason: null, nextRetryAt: null, automatic: false };

  const cur = error ? currentRecoveryOf(error, row.type ?? null, os, row.failure_class ?? null, row.run_created_at ?? null) : 'manual';
  // Una fecha persistida VENCIDA no cuenta como «programada» (ningún barrido la tomó): solo la decisión vigente.
  const at = scheduledRetryAtOf(row, now) ?? (next && next.getTime() > now.getTime() ? next : null);
  const attention = row.attention_reason ?? null;
  const code = error ? classifyFailure({ source: sourceOf(row.type), itemType: row.type ?? null, error, outputSummary: os }).code : null;
  if (cur === 'provider_probe' || (providerProbeViewOf(row as any, now, autoRecoveryEnabled(process.env)))) {
    return { state: 'waiting_external_quota', reason: 'provider_probe', nextRetryAt: iso(at), automatic: true };
  }
  if (youtubeQuotaWait(os, now) && attention !== 'unrecoverable') return { state: 'waiting_external_quota', reason: 'youtube_quota', nextRetryAt: iso(at), automatic: !!at };
  // Pago incierto: la conciliación (el reenvío único acotado de audio o la del proveedor, con el peor caso dentro de lo
  // autorizado) decide ANTES de cualquier llamada nueva; ninguna ronda del auto-heal la toca.
  if (cur === 'provider_reconcile' || cur === 'ambiguous_audio_resubmit') {
    return { state: 'waiting_financial_reconciliation', reason: cur, nextRetryAt: iso(at), automatic: true };
  }
  if (cur === 'auto_heal' || cur === 'auto_regenerate' || cur === 'safe_auto_retry' || cur === 'spend_control_resume') {
    // Espera EXPIRADA solo cuando el propio barrido que la tomaría lo dice explícitamente (auto-heal / reintento seguro:
    // too_old o ventana total agotada). r67 fix round 1 (F3): el control de gasto (espera su reversión) y el claim
    // incompleto de r62 d8 (lo resuelve su propio barrido, que registra la excepción al rendirse) nunca se marcan acá.
    const claimPayload = CLAIM_PAYLOAD_DEPENDENCY_RE.test(error);
    if (!at && toDate(row.finished_at ?? null) && cur !== 'spend_control_resume' && !claimPayload) {
      const policy = autoHealPolicyFromEnv(process.env);
      const r = { ...row, error, output_summary: os } as any;
      const expired = [autoHealDecision(r, now, policy), safeAutoRetryDecision(r, now, policy)]
        .some((d: any) => d.heal === false && (d.reason === 'too_old' || d.reason === 'recovery_window_exhausted'));
      if (expired) return { state: 'failed_no_strategies', reason: 'recovery_window_expired', nextRetryAt: null, automatic: false };
    }
    return { state: 'pending_retry', reason: cur, nextRetryAt: iso(at), automatic: true };
  }
  if (attention === 'duplicate_charge' || /^provider_reconciliation_required\b|ambiguous/i.test(error)) {
    return { state: 'waiting_financial_reconciliation', reason: code, nextRetryAt: null, automatic: false };
  }
  if (attention === 'budget' || attention === 'config' || attention === 'product_bug' || attention === 'dependency_unavailable') {
    return { state: 'blocked_permanent', reason: attention, nextRetryAt: null, automatic: false };
  }
  return { state: 'failed_no_strategies', reason: code, nextRetryAt: null, automatic: false };
}

export interface RunRecoveryView {
  /** El run tiene partes fallidas y NINGUNA tiene una recuperación automática segura pendiente. */
  definitive: boolean;
  byState: Record<string, number>;
  /** Partes que el sistema todavía va a retomar solo. */
  automatic: number;
}

/**
 * r67: estado de recuperación del RUN. Solo es «definitivamente fallido» cuando ninguna parte pendiente tiene una
 * estrategia automática segura (o expiró su espera). Las bloqueadas por dependencia siguen a su dependencia.
 */
export function runRecoveryStateOf(rows: ReadonlyArray<RecoveryRow>, now: Date = new Date()): RunRecoveryView {
  const byState: Record<string, number> = {};
  let automatic = 0;
  let failed = 0;
  for (const r of rows) {
    const v = recoveryStateOf(r, now);
    if (v.state) byState[v.state] = (byState[v.state] ?? 0) + 1;
    if (r.status === 'failed') failed++;
    if (v.automatic && v.reason !== 'dependency_blocked' && r.status !== 'completed') automatic++;
  }
  return { definitive: failed > 0 && automatic === 0, byState, automatic };
}
