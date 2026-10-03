// ─────────────────────────────────────────────────────────────────────────────
// REL — sonda del proveedor tras quedarse sin CRÉDITO / CUOTA (reanudación sin clic).
//
// Caso real (#616, staging 2026-10-03): la key de Anthropic de staging se quedó sin crédito
// («Your credit balance is too low», HTTP 400). Los items quedaron D / `wait_provider` / scope provider
// (failure-classifier.ts) y nada los reabría: aun con el crédito recargado, el curso no seguía sin un
// clic en «Continuar generación».
//
// Regla (decisión del usuario, brief CREDIT):
//  - SOLO crédito/cuota agotados de Anthropic («credit balance is too low», billing, «Sin disponibilidad
//    de generación» del proxy del navegador) y OpenAI (`insufficient_quota`): el proveedor confirma que no
//    generó ni cobró nada (4xx definitivo: la reserva del ledger se liberó). NUNCA auth / key inválida /
//    configuración (humano), NUNCA video, Gamma ni YouTube;
//  - por (run, proveedor) a lo sumo UN item canario reabierto a la vez; la primera sonda 5 min después del
//    fallo, luego 10, 20, 40 y 60 min (tope), con jitter (+0…20 %, nunca antes de la espera), acotado a
//    ~24 h desde el primer fallo de la racha (después: needs_attention como hoy). Nunca con el run
//    cancelado / cancelándose ni detenido por el usuario;
//  - canario OK → se reabren los demás items del run que esperan al mismo proveedor (y sus dependientes);
//    canario falla otra vez por crédito → la próxima sonda con la espera siguiente. Cada sonda concede UN
//    intento y no consume las rondas del auto-healer (autoHeal.rounds / regenRounds);
//  - la reapertura es la de siempre (RunsService.retryItem, modo `providerProbe`): locks, gate de FinOps
//    en simulación, y en el claim el runtime guard + el chequeo del ledger del worker;
//  - kill-switch: DYNAMIC_AUTO_HEAL_POLICY=legacy (política sin `classAware`).
// Estado: output_summary.providerProbe (clave del servidor; el navegador no la puede escribir).
// Puro (sin I/O).
// ─────────────────────────────────────────────────────────────────────────────
import { AUTO_HEAL_WORKER_ITEM_TYPES, AutoHealPolicy } from '../dynamic-generation/auto-heal';
import { FailureProvider, FailureSource, classifyFailure } from './failure-classifier';

export const PROVIDER_PROBE_STRATEGY = 'provider_probe';
export const PROVIDER_PROBE_RESUME_STRATEGY = 'provider_probe_resume';
/** Clave del servidor en output_summary. */
export const PROVIDER_PROBE_KEY = 'providerProbe';
/** Espera antes de la sonda n (índice n; el último valor se repite): 5, 10, 20, 40, 60 min. */
export const PROVIDER_PROBE_WAITS_SECONDS: readonly number[] = Object.freeze([300, 600, 1200, 2400, 3600]);
/** Jitter SOLO hacia arriba (+0…20 %): la sonda nunca sale antes de su espera. */
export const PROVIDER_PROBE_JITTER_RATIO = 0.2;
/** Tope de la racha desde el primer fallo por crédito (después: needs_attention como hoy). */
export const PROVIDER_PROBE_MAX_HOURS = 24;
/**
 * Un canario reabierto que sigue `pending` sin que nadie lo reclame (p.ej. un item del navegador con el
 * ejecutor pausado por OTRA parte) deja de contar como «en vuelo» pasado este tiempo: la próxima sonda
 * puede elegir otro. Un pendiente sin reclamar no llama a nadie (no gasta).
 */
export const PROVIDER_PROBE_STALL_SECONDS = 1800;
/** Tras un rechazo de la reapertura (FinOps, run reemplazado…): ese item no es canario por 30 min. */
export const PROVIDER_PROBE_SKIP_SECONDS = 1800;
export const PROVIDER_PROBE_PROVIDERS: readonly FailureProvider[] = Object.freeze(['anthropic', 'openai'] as FailureProvider[]);
/** Nunca: video (Videogen/YouTube) ni presentaciones (Gamma). */
const NEVER_PROBED_TYPES: readonly string[] = Object.freeze(['video', 'presentation']);

/** Crédito / cuota / facturación agotados (texto del proveedor o del proxy del navegador). */
const CREDIT_RE =
  /credit balance|insufficient_quota|exceeded your current quota|\bquota\b|\bcuota\b|\bsaldo\b|\bcredits?\b|cr[eé]ditos?\b|\bbalance\b|billing|facturaci[oó]n|payment required|\bHTTP 402\b|Sin disponibilidad de generaci[oó]n/i;
/** Autenticación / key / permisos: siempre humano, aunque el texto mencione crédito. */
const AUTH_RE =
  /\bHTTP 40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b|unauthori[sz]ed|forbidden|invalid[_ ]api[_ ]key|invalid x-api-key|authentication|api key no configurada|permission|No tienes acceso/i;
/** Filtro GRUESO del barrido (POSIX, case-insensitive). La decisión fina es providerCreditWaitOf. */
export const PROVIDER_PROBE_SQL_REGEX =
  'credit|balance|insufficient_quota|quota|cuota|saldo|cr[eé]dito|billing|facturaci[oó]n|payment required|HTTP 402|sin disponibilidad de generaci[oó]n';
/** Detenido por el usuario (el ejecutor del navegador lo reporta así): el run está pausado a mano. */
export const USER_STOPPED_SQL_REGEX = '^(user_stopped|generaci[oó]n detenida por el usuario)';
const USER_STOPPED_RE = /^(?:user_stopped\b|Generaci[oó]n detenida por el usuario)/i;

/** Reglas del clasificador cuyo veredicto de crédito puede sondearse (todas sin gasto confirmado). */
const PROBE_RULES: ReadonlySet<string> = new Set([
  'llm_config', 'audiobook_script_failed', 'tts_failed', 'llm_transient', 'unexpected_error', 'provider_config',
]);

export interface ProviderProbeRow {
  id: string;
  item_key?: string | null;
  type?: string | null;
  status: string;
  error: string | null;
  output_summary: Record<string, any> | null;
  finished_at?: Date | string | null;
  updated_at?: Date | string | null;
  claimed_at?: Date | string | null;
  /** Clase REGISTRADA al fallar (R2). Una C (pago incierto) nunca se sondea. */
  failure_class?: string | null;
}

/** Estado persistido en output_summary.providerProbe. */
export interface ProviderProbeState {
  provider: FailureProvider;
  /** Primer fallo por crédito de la racha (tope de ~24 h). */
  firstFailedAt?: string;
  /** Sondas ya hechas en el run para este proveedor cuando se escribió (la del canario incluida). */
  runRound?: number;
  /** Sondas en las que ESTE item fue el canario. */
  rounds?: number;
  /** Este item se reabrió como canario en este instante (en vuelo hasta que termine). */
  canaryAt?: string;
  lastProbeAt?: string;
  /** Próxima sonda del grupo (vista de recuperación). */
  nextProbeAt?: string;
  /** Rechazo de la reapertura: no es canario hasta este instante (ms). */
  skipUntilMs?: number;
  lastSkipReason?: string;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function sourceOfType(type: string | null | undefined): FailureSource | null {
  if (!type) return null;
  if (type === 'video') return 'video_worker';
  return AUTO_HEAL_WORKER_ITEM_TYPES.includes(type) ? 'provider_worker' : 'browser_executor';
}

/** Kill-switch: la sonda solo corre con la política por clase (DYNAMIC_AUTO_HEAL_POLICY=legacy la apaga). */
export function providerProbeEnabled(policy: AutoHealPolicy): boolean {
  return !!policy.classAware;
}

export function providerProbeStateOf(outputSummary: Record<string, any> | null | undefined): ProviderProbeState | null {
  const s = outputSummary?.[PROVIDER_PROBE_KEY];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (!PROVIDER_PROBE_PROVIDERS.includes(s.provider)) return null;
  return s as ProviderProbeState;
}

/**
 * ¿Este item `failed` espera a un proveedor que se quedó sin crédito/cuota? → el proveedor, o null.
 * Exige el veredicto del MENSAJE (hecho del emisor): D / wait_provider / scope provider de Anthropic u
 * OpenAI con texto de crédito y sin texto de auth. Un errorCode del navegador solo (mensaje de otra cosa)
 * nunca alcanza. Una clase C registrada (trozos de TTS ya pagados, reconciliación) nunca.
 */
export function providerCreditWaitOf(row: ProviderProbeRow): FailureProvider | null {
  if (row.status !== 'failed') return null;
  const error = String(row.error ?? '').trim();
  if (!error) return null;
  if (row.type && NEVER_PROBED_TYPES.includes(row.type)) return null;
  if (String(row.failure_class ?? '') === 'C') return null;
  if (!CREDIT_RE.test(error) || AUTH_RE.test(error)) return null;
  const v = classifyFailure({ source: sourceOfType(row.type), itemType: row.type ?? null, error, outputSummary: row.output_summary ?? {} });
  if (v.unclassified || v.class !== 'D' || v.scope !== 'provider') return null;
  if (v.paidRisk === 'uncertain' || (v.paidUnits ?? 0) > 0) return null;
  if (!PROBE_RULES.has(v.rule)) return null;
  // llm_config agrupa crédito, auth y configuración del proxy: solo el código de crédito.
  if (v.rule === 'llm_config' && v.code !== 'llm_credit_exhausted') return null;
  if (v.rule === 'provider_config' && v.code !== 'insufficient_quota') return null;
  if (v.rule !== 'llm_config' && v.rule !== 'provider_config' && !(v.strategy === 'wait_provider' && v.providerConfigIssue)) return null;
  const provider = v.provider ?? null;
  return provider && PROVIDER_PROBE_PROVIDERS.includes(provider) ? provider : null;
}

/** Espera (s) antes de la sonda `round` (0 = la primera), con jitter determinista +0…20 %. */
export function providerProbeWaitSeconds(round: number, seed: string): number {
  const list = PROVIDER_PROBE_WAITS_SECONDS;
  const base = list[Math.min(Math.max(0, round), list.length - 1)];
  const u = fnv1a(`${seed}:${round}`) / 0xffffffff;
  return base * (1 + PROVIDER_PROBE_JITTER_RATIO * u);
}

export type ProviderProbeAction =
  /** Nada que sondear (sin items esperando). */
  | 'none'
  /** Esperando la próxima sonda (nextProbeAt). */
  | 'wait'
  /** Toca reabrir el canario. */
  | 'probe'
  /** Un canario sigue en vuelo: no se reabre otro. */
  | 'in_flight'
  /** El canario (o una reapertura) terminó bien: reabrir el resto. */
  | 'resume'
  /** Pasaron ~24 h desde el primer fallo: needs_attention como hoy. */
  | 'exhausted'
  /** El usuario detuvo la generación: nunca se sondea. */
  | 'paused';

export interface ProviderProbePlan {
  provider: FailureProvider;
  action: ProviderProbeAction;
  /** Items `failed` que esperan a este proveedor (ids). */
  waitingIds: string[];
  /** Canario a reabrir (action 'probe'). */
  canaryId: string | null;
  /** Canario en vuelo (action 'in_flight'). */
  inFlightId: string | null;
  /** Items completados con estado de sonda (prueba de que el proveedor volvió). */
  successIds: string[];
  /** Sondas ya hechas en el run para este proveedor. */
  round: number;
  nextProbeAt: Date | null;
  streakStartAt: Date | null;
  deadlineAt: Date | null;
}

const IN_FLIGHT_STATUSES: readonly string[] = Object.freeze(['pending', 'retrying', 'running']);

/**
 * Plan de sondas de UN run (filas de la generación vigente con crédito agotado, con estado de sonda, o
 * detenidas por el usuario). `seed` = id del run (jitter determinista por run y proveedor). Puro: el
 * barrido lo usa para decidir y retryItem lo re-evalúa con las filas BLOQUEADAS.
 */
export function planProviderProbes(rows: readonly ProviderProbeRow[], now: Date, seed: string): ProviderProbePlan[] {
  const waitingBy = new Map<FailureProvider, ProviderProbeRow[]>();
  for (const r of rows) {
    const p = providerCreditWaitOf(r);
    if (!p) continue;
    if (!waitingBy.has(p)) waitingBy.set(p, []);
    waitingBy.get(p)!.push(r);
  }
  const providers = new Set<FailureProvider>(waitingBy.keys());
  for (const r of rows) {
    const s = providerProbeStateOf(r.output_summary);
    if (s) providers.add(s.provider);
  }
  const paused = rows.some((r) => r.status === 'failed' && USER_STOPPED_RE.test(String(r.error ?? '').trim()));
  const out: ProviderProbePlan[] = [];
  for (const provider of [...providers].sort()) {
    const waiting = waitingBy.get(provider) ?? [];
    const withState = rows.filter((r) => providerProbeStateOf(r.output_summary)?.provider === provider);
    const round = withState.reduce((m, r) => Math.max(m, Math.floor(Number(providerProbeStateOf(r.output_summary)?.runRound ?? 0)) || 0), 0);
    const successIds = withState.filter((r) => r.status === 'completed').map((r) => String(r.id));
    const base: ProviderProbePlan = {
      provider, action: 'none', waitingIds: waiting.map((r) => String(r.id)), canaryId: null, inFlightId: null, successIds,
      round, nextProbeAt: null, streakStartAt: null, deadlineAt: null,
    };
    // El proveedor volvió (el canario —o una reapertura de un humano— terminó bien): se reabre el resto.
    if (successIds.length) {
      out.push({ ...base, action: 'resume' });
      continue;
    }
    if (!waiting.length) {
      out.push(base);
      continue;
    }
    const firstOf = (r: ProviderProbeRow) => toDate(providerProbeStateOf(r.output_summary)?.firstFailedAt) ?? toDate(r.finished_at) ?? toDate(r.updated_at) ?? now;
    const streakStartAt = new Date(Math.min(...waiting.map((r) => firstOf(r).getTime())));
    const deadlineAt = new Date(streakStartAt.getTime() + PROVIDER_PROBE_MAX_HOURS * 3_600_000);
    const lastFailAt = new Date(Math.max(...waiting.map((r) => (toDate(r.finished_at) ?? toDate(r.updated_at) ?? now).getTime())));
    let nextProbeAt = new Date(lastFailAt.getTime() + providerProbeWaitSeconds(round, `${seed}:${provider}`) * 1000);
    if (nextProbeAt.getTime() > deadlineAt.getTime()) nextProbeAt = deadlineAt;
    const plan: ProviderProbePlan = { ...base, streakStartAt, deadlineAt, nextProbeAt };
    if (paused) {
      out.push({ ...plan, action: 'paused', nextProbeAt: null });
      continue;
    }
    const inFlight = withState.find((r) => {
      if (!IN_FLIGHT_STATUSES.includes(r.status)) return false;
      const s = providerProbeStateOf(r.output_summary)!;
      const canaryAt = toDate(s.canaryAt);
      if (!canaryAt) return false;
      // Pendiente sin reclamar desde la reapertura por más de PROVIDER_PROBE_STALL_SECONDS: no cuenta.
      const claimedAt = toDate(r.claimed_at);
      const neverClaimed = r.status === 'pending' && (!claimedAt || claimedAt.getTime() < canaryAt.getTime());
      return !(neverClaimed && now.getTime() - canaryAt.getTime() > PROVIDER_PROBE_STALL_SECONDS * 1000);
    });
    if (inFlight) {
      out.push({ ...plan, action: 'in_flight', inFlightId: String(inFlight.id), nextProbeAt: null });
      continue;
    }
    if (now.getTime() > deadlineAt.getTime()) {
      out.push({ ...plan, action: 'exhausted', nextProbeAt: null });
      continue;
    }
    if (now.getTime() < nextProbeAt.getTime()) {
      out.push({ ...plan, action: 'wait' });
      continue;
    }
    // Canario: primero un item del SERVIDOR (no depende de que haya un navegador abierto); si no, el item del
    // navegador que falló último (el que pausó al ejecutor: reabrirlo lo reanuda). Sin los rechazados recientes.
    const pickable = waiting.filter((r) => {
      const skip = Number(providerProbeStateOf(r.output_summary)?.skipUntilMs ?? 0);
      return !(Number.isFinite(skip) && skip > now.getTime());
    });
    if (!pickable.length) {
      out.push({ ...plan, action: 'wait' });
      continue;
    }
    const isWorker = (r: ProviderProbeRow) => !!r.type && AUTO_HEAL_WORKER_ITEM_TYPES.includes(r.type);
    const failedMs = (r: ProviderProbeRow) => (toDate(r.finished_at) ?? toDate(r.updated_at) ?? now).getTime();
    const canary = [...pickable].sort((a, b) =>
      (Number(isWorker(b)) - Number(isWorker(a))) || (failedMs(b) - failedMs(a)) || String(a.id).localeCompare(String(b.id)))[0];
    out.push({ ...plan, action: 'probe', canaryId: String(canary.id) });
  }
  return out;
}

/**
 * Vista de recuperación de UN item (sin el resto del run): ¿la sonda lo está esperando? → la próxima sonda
 * (la persistida por el barrido, o la primera estimada desde el fallo) y el tope. null = no aplica (vencido,
 * no es crédito, kill-switch): la vista sigue como hoy.
 */
export function providerProbeViewOf(row: ProviderProbeRow, now: Date, enabled: boolean): { provider: FailureProvider; nextProbeAt: Date; deadlineAt: Date } | null {
  if (!enabled) return null;
  const provider = providerCreditWaitOf(row);
  if (!provider) return null;
  const s = providerProbeStateOf(row.output_summary);
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at) ?? now;
  const first = toDate(s?.provider === provider ? s.firstFailedAt : null) ?? failedAt;
  const deadlineAt = new Date(first.getTime() + PROVIDER_PROBE_MAX_HOURS * 3_600_000);
  if (now.getTime() > deadlineAt.getTime()) return null;
  const persisted = s?.provider === provider ? toDate(s.nextProbeAt) : null;
  const nextProbeAt = persisted && persisted.getTime() >= failedAt.getTime()
    ? persisted
    : new Date(failedAt.getTime() + PROVIDER_PROBE_WAITS_SECONDS[0] * 1000);
  return { provider, nextProbeAt, deadlineAt };
}
