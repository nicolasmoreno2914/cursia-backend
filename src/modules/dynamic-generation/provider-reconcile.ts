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
import { VIDEOGEN_RENDER_OVERDUE, videogenMaxRenderMs } from './videogen-render-cap';

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
 * Si los GET siguen fallando (o Gamma no informa los créditos) durante este tiempo desde el fallo, la evidencia se da
 * por no disponible. Con un job/generación TERMINAL eso es una liquidación conservadora (`charged`, sin render vivo);
 * con un estado desconocido o vivo (review C1) es una excepción, nunca un reenvío.
 */
export const PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS = 6 * 3600;
/**
 * Review C1 + E2E r62: un job de Videogen todavía vivo se sigue consultando (sin reenviar) hasta el tope ÚNICO de render
 * (DYNAMIC_VIDEOGEN_MAX_RENDER_MS, videogen-render-cap.ts, el mismo del worker), contado desde el primer poll del job.
 */
export function providerReconcileLiveJobMaxSeconds(env: Record<string, string | undefined> = process.env): number {
  return videogenMaxRenderMs(env) / 1000;
}
/** Espera creciente entre consultas de un job vivo / un lookup caído (la última se repite). */
export const PROVIDER_RECONCILE_RECHECK_SECONDS: readonly number[] = Object.freeze([120, 300, 600, 1200, 1800]);
/** Review I1: un costo 0 solo libera la reserva tras DOS lecturas en 0 separadas por al menos esto. */
export const PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS = 600;
/** Review M3: re-poll de un job terminado bien (gratis): tope propio, no consume reenvíos. */
export const PROVIDER_RECONCILE_MAX_REPOLLS = 3;
/** Review I4: tope de consultas al proveedor del bucle d5 por tick (el tick es serial con el empaque automático). */
export const PROVIDER_RECONCILE_D5_MAX_LOOKUPS_PER_TICK = 10;
/**
 * Timeout de cada GET al proveedor desde el barrido: se pasa como opción por llamada a VideogenService (que sin ella no
 * tiene timeout, para no cambiar V1) y además acota la espera con withTimeout (también para Gamma).
 */
export const PROVIDER_RECONCILE_LOOKUP_TIMEOUT_MS = 30_000;
/** Regex POSIX gruesa del barrido (la decisión fina es providerReconcileDecision). */
export const PROVIDER_RECONCILE_SQL_REGEX = '^(videogen_failed|videogen_render_overdue|video_timeout|ambiguous_video_submission|gamma_generation_failed|gamma_submit_ambiguous)';
/**
 * Review M1 — runs históricos que ningún mecanismo automático de r62 toca (directiva: «no se tocan los cursos
 * históricos»): corte por `production_jobs.created_at` (solo runs creados desde la activación; env
 * PROVIDER_RECONCILE_RUNS_SINCE) + los ids de run conocidos (#1209 6ccb5763…, #1353 d7155541…, #1510 1c02fd27…; de
 * #1510 solo se conoce el prefijo en los reportes). Sus reservas siguen siendo de la herramienta de admin.
 */
export const PROVIDER_RECONCILE_RUNS_SINCE_DEFAULT = '2026-10-20T00:00:00Z';
export const PROVIDER_RECONCILE_RUNS_SINCE_ENV = 'PROVIDER_RECONCILE_RUNS_SINCE';
export const PROVIDER_RECONCILE_EXCLUDED_RUN_IDS: readonly string[] = Object.freeze([
  '6ccb5763-5c44-4ce4-9c1b-bf05ed155b4a', // #1209
  'd7155541-2ec4-43a4-ba3c-fb0787c17852', // #1353
]);
export const PROVIDER_RECONCILE_EXCLUDED_RUN_PREFIXES: readonly string[] = Object.freeze(['1c02fd27']); // #1510

export function providerReconcileRunsSince(env: Record<string, string | undefined> = process.env): string {
  const v = String(env[PROVIDER_RECONCILE_RUNS_SINCE_ENV] ?? '').trim();
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : PROVIDER_RECONCILE_RUNS_SINCE_DEFAULT;
}

/** ¿El run entra en la conciliación automática? (corte por fecha + ids históricos). Sin datos del run → no se excluye. */
export function providerReconcileRunEligible(run: { id?: string | null; created_at?: Date | string | null } | null | undefined,
  env: Record<string, string | undefined> = process.env): boolean {
  const id = String(run?.id ?? '').toLowerCase();
  if (id && (PROVIDER_RECONCILE_EXCLUDED_RUN_IDS.includes(id) || PROVIDER_RECONCILE_EXCLUDED_RUN_PREFIXES.some((p) => id.startsWith(p)))) return false;
  const c = run?.created_at ? toDate(run.created_at) : null;
  if (c && c.getTime() < Date.parse(providerReconcileRunsSince(env))) return false;
  return true;
}

/**
 *  - `videogen_failed`: render fallido con jobId (d4, #1510) → estado + costo del job;
 *  - `videogen_stuck`: el job nunca termina (`video_timeout` con el auto-healer agotado) → estado; si sigue sin
 *    terminar, conservador (el job todavía puede cobrar);
 *  - `videogen_orphan`: envío con jobId que el worker no llegó a persistir (sufijo `(job de Videogen <id>)` del error,
 *    review I3) → misma vía con evidencia que `videogen_failed` (vivo: se espera; terminal: se concilia);
 *  - `videogen_ambiguous`: envío sin jobId (c2) → conservador;
 *  - `gamma_failed`: generación fallida con generationId (d13) → `credits.deducted`;
 *  - `gamma_ambiguous`: envío sin generationId (c3) → conservador.
 */
export type ProviderReconcileKind = 'videogen_failed' | 'videogen_stuck' | 'videogen_overdue' | 'videogen_orphan' | 'videogen_ambiguous' | 'gamma_failed' | 'gamma_ambiguous';
export const PROVIDER_RECONCILE_KINDS: readonly ProviderReconcileKind[] = Object.freeze(
  ['videogen_failed', 'videogen_stuck', 'videogen_overdue', 'videogen_orphan', 'videogen_ambiguous', 'gamma_failed', 'gamma_ambiguous'] as ProviderReconcileKind[],
);
/** Las que no tienen id del proveedor que consultar (siempre punto 3). */
export const PROVIDER_RECONCILE_AMBIGUOUS_KINDS: readonly ProviderReconcileKind[] = Object.freeze(
  ['videogen_ambiguous', 'gamma_ambiguous'] as ProviderReconcileKind[],
);
/** Las de Videogen con jobId (estado + costo consultables). */
export const PROVIDER_RECONCILE_VIDEOGEN_JOB_KINDS: readonly ProviderReconcileKind[] = Object.freeze(
  ['videogen_failed', 'videogen_stuck', 'videogen_overdue', 'videogen_orphan'] as ProviderReconcileKind[],
);

/** Review I3: jobId del sufijo ANCLADO que agrega el worker (`… (job de Videogen <id>)`, dynamic-item-worker.ts). */
export function videogenJobIdFromError(error: string | null | undefined): string | null {
  const m = /\(job de Videogen ([A-Za-z0-9_.:\-]{1,200})\)\s*$/.exec(String(error ?? ''));
  return m ? m[1] : null;
}

/** jobId de la parte: el persistido o, si no, el del sufijo del error. */
export function videogenJobIdOf(os: Record<string, any> | null | undefined, error: string | null | undefined): string | null {
  const persisted = os?.external?.videogenJobId;
  if (typeof persisted === 'string' && persisted) return persisted;
  return videogenJobIdFromError(error);
}

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
  | 'not_failed' | 'not_applicable' | 'declined' | 'cap_reached' | 'ambiguous_cap_reached' | 'too_old' | 'backoff' | 'run_excluded';

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
    // E2E r62: el worker dejó la parte failed al pasar el tope único de render con el job vivo.
    if (new RegExp(`^${VIDEOGEN_RENDER_OVERDUE}\\b`).test(e)) return hasVideogenJob(os) ? 'videogen_overdue' : null;
    if (/^video_timeout\b/.test(e)) {
      // Solo cuando el re-poll gratis del auto-healer ya se agotó (antes, el auto-healer sigue esperando al job).
      return hasVideogenJob(os) && autoHealRoundsOf(os) >= autoHealMaxRoundsFor('video', policy) ? 'videogen_stuck' : null;
    }
    // Sin jobId (ni persistido ni en el sufijo del error): nada que consultar (c2). Con jobId: vía con evidencia (I3).
    if (/^ambiguous_video_submission\b/.test(e)) return videogenJobIdOf(os, e) ? 'videogen_orphan' : 'videogen_ambiguous';
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
  run?: { id?: string | null; created_at?: Date | string | null } | null,
): ProviderReconcileDecision {
  if (row.status !== 'failed') return { heal: false, reason: 'not_failed' };
  if (run && !providerReconcileRunEligible(run)) return { heal: false, reason: 'run_excluded' };
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
  // Consulta reprogramada (job vivo / lookup caído / segunda lectura de un costo 0), solo para ESTE error.
  const next = toDate(st.nextCheckAt ?? null);
  if (next && String(st.nextCheckError ?? '') === String(row.error ?? '') && now.getTime() < next.getTime()) {
    return { heal: false, reason: 'backoff', kind, retryAt: next };
  }
  return { heal: true, kind, round: rounds + 1, ambiguousRounds, ambiguousAllowed };
}

/**
 * Para la completitud del run / el clasificador: ¿el servidor todavía la va a resolver solo? (decisión elegible o en
 * espera, dentro del techo: espera + tiempo máximo de consulta + 3 ticks; pasado el techo la acción de admin aparece).
 */
export function providerReconcilePending(row: ProviderReconcileRow, now: Date, tickMs: number, policy?: AutoHealPolicy,
  run?: { id?: string | null; created_at?: Date | string | null } | null): boolean {
  const d = providerReconcileDecision(row, now, policy, run);
  if (!(d.heal === true || (d.heal === false && d.reason === 'backoff'))) return false;
  const failedAt = toDate(row.finished_at) ?? toDate(row.updated_at);
  if (!failedAt) return true;
  const horizon = Math.max(PROVIDER_RECONCILE_LOOKUP_GIVEUP_SECONDS, providerReconcileLiveJobMaxSeconds()) +
    PROVIDER_RECONCILE_BACKOFF_SECONDS + PROVIDER_RECONCILE_RECHECK_SECONDS[PROVIDER_RECONCILE_RECHECK_SECONDS.length - 1];
  return now.getTime() < failedAt.getTime() + horizon * 1000 + 3 * Math.max(0, tickMs);
}

/** Espera antes de la consulta n+1 (la última se repite). */
export function providerReconcileRecheckSeconds(checks: number): number {
  const l = PROVIDER_RECONCILE_RECHECK_SECONDS;
  return l[Math.min(Math.max(0, Math.floor(checks)), l.length - 1)];
}

/**
 * Review I1 — monto contado de una reserva de Videogen con el costo ESTIMADO informado: el mayor entre lo informado y
 * la suma del desglose (piso por etapa). Nunca se cuenta MENOS que lo informado (si supera la reserva, se cuenta todo).
 */
export function videogenCountedAmount(reportedCost: number, breakdown?: Record<string, number> | null): number {
  if (!Number.isFinite(reportedCost) || reportedCost < 0) throw new Error(`costo de Videogen inválido: ${reportedCost}`);
  const parts = breakdown && typeof breakdown === 'object' ? Object.values(breakdown).map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  return Math.max(reportedCost, parts.reduce((t, n) => t + n, 0));
}

/** Etapas de Videogen que implican llamadas pagadas (guion, escenas, imágenes, voz, render, subida). */
const VIDEOGEN_PAID_STAGE_RE = /script|guion|scene|escena|image|imagen|tts|voice|voz|audio|render|ffmpeg|upload|youtube|openai|elevenlabs|anthropic|\b429\b/i;

/**
 * Review I1 — ¿un costo 0 libera la reserva? Solo si: el job quedó `failed` (nunca `completed`), el desglose está
 * presente y todos sus componentes son 0 (o vacío), el error no menciona ninguna etapa con llamadas pagadas, y hubo dos
 * lecturas en 0 separadas por ≥ PROVIDER_RECONCILE_ZERO_CONFIRM_SECONDS (la segunda la decide el barrido).
 */
export function videogenZeroCostReleasable(a: { status: string; error: string | null | undefined; reportedCost: number; breakdown: Record<string, number> | null | undefined }): boolean {
  if (String(a.status ?? '').toLowerCase() !== 'failed' && String(a.status ?? '').toLowerCase() !== 'error') return false;
  if (!(a.reportedCost === 0)) return false;
  if (!a.breakdown || typeof a.breakdown !== 'object') return false;
  if (Object.values(a.breakdown).some((v) => !(Number(v) === 0))) return false;
  return !VIDEOGEN_PAID_STAGE_RE.test(String(a.error ?? ''));
}

/** Créditos medidos que el worker anotó en `gamma_generation_failed` (null = Gamma no los informó). */
export function gammaMeasuredCreditsOf(error: string | null | undefined): number | null {
  const m = /\[créditos medidos: (\d+(?:\.\d+)?)\]\. No se reenvía sola/.exec(String(error ?? ''));
  return m ? Number(m[1]) : null;
}
