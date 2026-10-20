// ─────────────────────────────────────────────────────────────────────────────
// r62 (N2) — conciliación AUTOMÁTICA de reservas de Videogen / Gamma con la evidencia del proveedor y reenvío
// acotado (puntos d4, d5, d13, c2 y c3 de L-flow; REGLA DE AMBIGÜEDAD ACOTADA de r62).
//
// Antes, un render fallido de Videogen con jobId (`videogen_failed`, caso #1510) o una generación fallida de Gamma
// (`gamma_generation_failed`) quedaban `hold_for_human`: la reserva pendiente esperaba a un SUPER_ADMIN
// (`reconcile_videogen_reservation`) y el reenvío también (`resubmitVideo` / `resubmitProvider`). Ahora el barrido
// del servidor (ProviderReconcileService, mismo tick que el auto-healer):
//  1. con id del proveedor (falla CONOCIDA): consulta los GET existentes (Videogen: estado + costo del job; Gamma:
//     `credits.deducted`) y concilia la reserva con esa evidencia (`released` / `charged_partial` / `charged`, mecanismo
//     r60, `decidedBy='system'`). El costo de Videogen es un ESTIMADO: se usa el valor informado con tope en la reserva;
//  2. sin id (envío realmente ambiguo, c2/c3) o sin evidencia (lookup que no responde, créditos que Gamma no informa,
//     job que nunca termina): liquidación CONSERVADORA como `charged` con la marca `possible_duplicate`;
//  3. reenvía SOLO si el peor caso (lo ya liquidado + la reserva nueva) entra en el presupuesto de recuperación de la
//     parte y en el saldo autorizado del run (run-spend-guard.ts). Si no entra, la excepción queda registrada
//     (`providerReconcile.declined` + `attention_reason`), nunca un reintento ciego.
// Topes por parte: a lo sumo PROVIDER_RECONCILE_MAX_RESUBMITS reenvíos automáticos y, de ellos, a lo sumo
// PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS con resultado ambiguo. Puro (sin I/O): la decisión la usan el barrido,
// retryItem (bajo lock), la completitud del run y el clasificador (qué hace HOY el sistema).
// ─────────────────────────────────────────────────────────────────────────────
import { AutoHealPolicy, autoHealMaxRoundsFor, autoHealPolicyFromEnv, autoHealRoundsOf } from './auto-heal';

/** Clave del estado en output_summary. */
export const PROVIDER_RECONCILE_KEY = 'providerReconcile';
/** Código / estrategia del reenvío automático (auditoría, generation_item_attempts.strategy_applied). */
export const PROVIDER_RECONCILE_CODE = 'provider_reconcile';
/**
 * Propuesta r62 (N2): DOS reenvíos automáticos por parte (= hasta 3 renders de esa parte en total). Con #1510 un
 * reenvío bastó; el segundo cubre una segunda falla conocida del proveedor (p.ej. otro 429 en generate_script) sin
 * mandar a un humano. Después queda la excepción registrada. Además, siempre manda el presupuesto de la parte.
 */
export const PROVIDER_RECONCILE_MAX_RESUBMITS = 2;
/** Regla de ambigüedad acotada (punto 3): nunca más de UN reenvío ambiguo por parte. */
export const PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS = 1;
/** Espera desde el fallo antes de consultar al proveedor (deja asentar el estado / costo del job). */
export const PROVIDER_RECONCILE_BACKOFF_SECONDS = 120;
/**
 * Si los GET de estado/costo siguen fallando (o Gamma no informa los créditos) durante este tiempo desde el fallo,
 * la evidencia se da por no disponible y se aplica la liquidación conservadora (punto 3).
 */
export const PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS = 6 * 3600;
/** Timeout de cada GET al proveedor desde el barrido (las llamadas de VideogenService no tienen timeout propio). */
export const PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS = 30_000;
/** Regex POSIX gruesa del barrido (la decisión fina es providerReconcileDecision). */
export const PROVIDER_RECONCILE_SQL_REGEX = '^(videogen_failed|video_timeout|ambiguous_video_submission|gamma_generation_failed|gamma_submit_ambiguous)';
/**
 * Cursos históricos que ningún mecanismo automático de r62 toca (directiva del usuario: «no se tocan los cursos
 * históricos»). Sus reservas siguen siendo de la herramienta de admin.
 */
export const PROVIDER_RECONCILE_EXCLUDED_COURSE_IDS: readonly number[] = Object.freeze([1209, 1353, 1510]);

/**
 *  - `videogen_failed`: render fallido con jobId (d4, #1510) → estado + costo del job;
 *  - `videogen_stuck`: el job nunca termina (`video_timeout` con el auto-healer agotado) → estado; si sigue sin
 *    terminar, conservador (el job todavía puede cobrar);
 *  - `videogen_ambiguous`: envío sin jobId (c2) → conservador;
 *  - `gamma_failed`: generación fallida con generationId (d13) → `credits.deducted`;
 *  - `gamma_ambiguous`: envío sin generationId (c3) → conservador.
 */
export type ProviderReconcileKind = 'videogen_failed' | 'videogen_stuck' | 'videogen_ambiguous' | 'gamma_failed' | 'gamma_ambiguous';
export const PROVIDER_RECONCILE_KINDS: readonly ProviderReconcileKind[] = Object.freeze(
  ['videogen_failed', 'videogen_stuck', 'videogen_ambiguous', 'gamma_failed', 'gamma_ambiguous'] as ProviderReconcileKind[],
);
/** Las que de entrada no tienen evidencia (siempre punto 3). */
export const PROVIDER_RECONCILE_AMBIGUOUS_KINDS: readonly ProviderReconcileKind[] = Object.freeze(
  ['videogen_stuck', 'videogen_ambiguous', 'gamma_ambiguous'] as ProviderReconcileKind[],
);

export interface ProviderReconcileRow {
  id?: string | null;
  status: string;
  type?: string | null;
  error: string | null;
  output_summary: Record<string, any> | null;
  finished_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export type ProviderReconcileSkipReason =
  | 'not_failed' | 'not_applicable' | 'declined' | 'cap_reached' | 'ambiguous_cap_reached' | 'too_old' | 'backoff';

export type ProviderReconcileDecision =
  | { heal: true; kind: ProviderReconcileKind; round: number; ambiguousRounds: number; ambiguousAllowed: boolean }
  | { heal: false; reason: ProviderReconcileSkipReason; kind?: ProviderReconcileKind; retryAt?: Date };

/** Motivos que no cambian sin un error nuevo (el barrido registra la excepción y no vuelve a mirar). */
export const PROVIDER_RECONCILE_PERMANENT_SKIPS: readonly ProviderReconcileSkipReason[] = Object.freeze(
  ['cap_reached', 'ambiguous_cap_reached'] as ProviderReconcileSkipReason[],
);

const hasVideogenJob = (os: Record<string, any>) => typeof os?.external?.videogenJobId === 'string' && os.external.videogenJobId !== '';
const hasGammaId = (os: Record<string, any>) => typeof os?.external?.gammaGenerationId === 'string' && os.external.gammaGenerationId !== '';

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function providerReconcileStateOf(os: Record<string, any> | null | undefined): Record<string, any> {
  const s = os?.[PROVIDER_RECONCILE_KEY];
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

function intOf(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Reenvíos automáticos ya usados por la parte (todos / ambiguos). */
export function providerReconcileRoundsOf(os: Record<string, any> | null | undefined): { rounds: number; ambiguousRounds: number } {
  const s = providerReconcileStateOf(os);
  return { rounds: intOf(s.rounds), ambiguousRounds: intOf(s.ambiguousRounds) };
}

/** Qué caso es (null = no lo resuelve este mecanismo). */
export function providerReconcileKindOf(
  type: string | null | undefined,
  error: string | null | undefined,
  outputSummary: Record<string, any> | null | undefined,
  policy: AutoHealPolicy = autoHealPolicyFromEnv(process.env),
): ProviderReconcileKind | null {
  const e = String(error ?? '').trim();
  const os = outputSummary ?? {};
  if (type === 'video') {
    if (/^videogen_failed\b/.test(e)) return hasVideogenJob(os) ? 'videogen_failed' : null;
    if (/^video_timeout\b/.test(e)) {
      // Solo cuando el re-poll gratis del auto-healer ya se agotó (antes, el auto-healer sigue esperando al job).
      return hasVideogenJob(os) && autoHealRoundsOf(os) >= autoHealMaxRoundsFor('video', policy) ? 'videogen_stuck' : null;
    }
    // Sin jobId persistido: no hay nada que consultar (c2). Con jobId persistido el worker nunca marca ambiguo.
    if (/^ambiguous_video_submission\b/.test(e)) return hasVideogenJob(os) ? null : 'videogen_ambiguous';
    return null;
  }
  if (type === 'presentation') {
    if (/^gamma_generation_failed\b/.test(e)) return hasGammaId(os) ? 'gamma_failed' : null;
    if (/^gamma_submit_ambiguous\b/.test(e)) return hasGammaId(os) ? null : 'gamma_ambiguous';
  }
  return null;
}

/**
 * Decisión pura: ¿el barrido va a conciliar y (si entra en el presupuesto) reenviar esta parte? No mira el
 * ledger ni al proveedor (eso lo hace el barrido, que puede terminar registrando la excepción).
 */
export function providerReconcileDecision(
  row: ProviderReconcileRow,
  now: Date,
  policy: AutoHealPolicy = autoHealPolicyFromEnv(process.env),
): ProviderReconcileDecision {
  if (row.status !== 'failed') return { heal: false, reason: 'not_failed' };
  const os = (row.output_summary ?? {}) as Record<string, any>;
  const kind = providerReconcileKindOf(row.type, row.error, os, policy);
  if (!kind) return { heal: false, reason: 'not_applicable' };
  const st = providerReconcileStateOf(os);
  // La excepción registrada vale para ESE error (un error nuevo la reemplaza: ver declinedError).
  if (st.declined && String(st.declinedError ?? '') === String(row.error ?? '')) return { heal: false, reason: 'declined', kind };
  const { rounds, ambiguousRounds } = providerReconcileRoundsOf(os);
  if (rounds >= PROVIDER_RECONCILE_MAX_RESUBMITS) return { heal: false, reason: 'cap_reached', kind };
  const ambiguousAllowed = ambiguousRounds < PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS;
  if (PROVIDER_RECONCILE_AMBIGUOUS_KINDS.includes(kind) && !ambiguousAllowed) return { heal: false, reason: 'ambiguous_cap_reached', kind };
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  if (failedAt && now.getTime() - failedAt.getTime() > policy.maxAgeHours * 3_600_000) return { heal: false, reason: 'too_old', kind };
  if (failedAt) {
    const retryAt = new Date(failedAt.getTime() + PROVIDER_RECONCILE_BACKOFF_SECONDS * 1000);
    if (now.getTime() < retryAt.getTime()) return { heal: false, reason: 'backoff', kind, retryAt };
  }
  return { heal: true, kind, round: rounds + 1, ambiguousRounds, ambiguousAllowed };
}

/**
 * Para la completitud del run / el clasificador: ¿el servidor todavía la va a resolver solo? (decisión elegible o en
 * espera, dentro del techo: espera + tiempo máximo de consulta + 3 ticks; pasado el techo la acción de admin aparece).
 */
export function providerReconcilePending(row: ProviderReconcileRow, now: Date, tickMs: number, policy?: AutoHealPolicy): boolean {
  const d = providerReconcileDecision(row, now, policy);
  if (!(d.heal === true || (d.heal === false && d.reason === 'backoff'))) return false;
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  if (!failedAt) return true;
  return now.getTime() < failedAt.getTime() + (PROVIDER_RECONCILE_BACKOFF_SECONDS + PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS) * 1000 + 3 * Math.max(0, tickMs);
}

/** Monto contado de una reserva de Videogen con el costo ESTIMADO informado: el informado, con tope en la reserva. */
export function videogenCountedAmount(reportedCost: number, reserved: number): number {
  if (!Number.isFinite(reportedCost) || reportedCost < 0) throw new Error(`costo de Videogen inválido: ${reportedCost}`);
  return Math.min(reportedCost, reserved);
}

/** Créditos medidos que el worker anotó en `gamma_generation_failed` (null = Gamma no los informó). */
export function gammaMeasuredCreditsOf(error: string | null | undefined): number | null {
  const m = /\[créditos medidos: (\d+(?:\.\d+)?)\]\. No se reenvía sola/.exec(String(error ?? ''));
  return m ? Number(m[1]) : null;
}
