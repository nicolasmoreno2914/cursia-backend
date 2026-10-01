/**
 * EV6 T5 fase B2 — «Generar videos reales»: el upgrade de un run V2.1 (rulesVersion 3) cuyos
 * videos son de vista previa (mock) a videos reales, SOLO para los videos pendientes del run
 * actual (y sus video_interactions). Helpers puros + la regla de lectura de empaque degradado;
 * la orquestación (preview / confirm, locks, FinOps) vive en RunsService.
 *
 * Modelo (T5-design.md §2, § Rulings):
 *  - El run pasa UNA vez de `videoMode:'mock'` a `'real'` (monótono, auditado): se conserva
 *    `videoModeOriginal:'mock'` y `videoUpgrade` (id, quién, cuándo, huella, items, aprobación).
 *    Todos los lectores de dinero (gates de retry/regenerate, worker, publicador YouTube,
 *    presupuesto) leen `input_payload.videoMode`, así que quedan coherentes sin tocarlos.
 *  - Ruling 6: en un run con `videoMode:'real'`, un item video con `output_summary.mode:'mock'`
 *    solo es aceptable (como pendiente) si existe `videoUpgrade`; si no, es una inconsistencia y
 *    se falla fuerte (nunca se empaqueta en silencio ni se ofrece pagarlo otra vez).
 *  - Empaque degradado (§2.6): si un video del upgrade falla definitivamente, o el usuario CANCELA
 *    el run mientras se generan (fix round 1, I-1), el run termina `failed`/`cancelled`; igual se
 *    puede empaquetar con ese capítulo sin video (su generación completada vigente sigue siendo la
 *    de vista previa → pendiente). Reabrir el run NO vuelve a encolar esos videos pagos.
 *  - Un SEGUNDO upgrade en el mismo run está permitido cuando el anterior ya no tiene nada en
 *    vuelo y quedan videos pendientes (fallidos o cancelados): siempre con vista previa y aprobación
 *    NUEVAS y solo para esos videos. La idempotencia es POR UPGRADE: una confirmación con la huella
 *    de un upgrade ya registrado (vigente o del historial) devuelve ESE upgrade; mientras uno está en
 *    vuelo, cualquier confirmación devuelve el que está en vuelo; y la huella incluye la generación
 *    vigente de cada video, así que una pestaña vieja nunca crea un segundo upgrade (estimate_stale).
 *    Un video cuyo intento cancelado ya tenía un render en Videogen REUTILIZA ese job (se vuelve a
 *    consultar, no se vuelve a pagar) y no entra en el estimado.
 */
import { createHash } from 'crypto';

export const VIDEO_UPGRADE_REASON = 'video_upgrade';
export const VIDEO_UPGRADE_CASCADE_REASON = 'cascade_from_video';
/** Ruling 6: item mock dentro de un run real sin upgrade. */
export const VIDEO_MODE_INCONSISTENT = 'video_mode_inconsistent';
export const VIDEO_UPGRADE_NOT_ALLOWED_RULES = 'video_upgrade_rules_version_unsupported';
export const VIDEO_UPGRADE_RUN_NOT_READY = 'video_upgrade_run_not_ready';
export const VIDEO_UPGRADE_NOTHING_PENDING = 'video_upgrade_nothing_pending';
/** Un intento anterior quedó con un envío a Videogen ambiguo: resolverlo antes (nunca un envío nuevo a ciegas). */
export const VIDEO_UPGRADE_AMBIGUOUS_SUBMISSION = 'video_upgrade_ambiguous_submission';
/** Motivos de regeneración que escribe el upgrade (videos y sus interacciones). */
export const VIDEO_UPGRADE_REASONS = [VIDEO_UPGRADE_REASON, VIDEO_UPGRADE_CASCADE_REASON];
/** Estados de una generación EN VUELO. */
export const VIDEO_UPGRADE_IN_FLIGHT_STATES = ['pending', 'running', 'retrying'];

export interface VideoUpgradeRecord {
  id: string;
  at: string;
  /** owner del run (quien lo pidió). */
  by: string;
  /** email de quien confirmó (aprobó) — SUPER_ADMIN o el owner con una autorización vigente. */
  confirmedBy: string | null;
  /** EV6 DoD fix round 1 (I2): id del SUPER_ADMIN que actuó sobre el curso de otro owner (ausente si es el dueño). */
  actedBy?: string;
  estimateHash: string;
  /** Keys `video:<ch>` regenerados en modo real. */
  itemKeys: string[];
  /** Keys `video_interactions:<ch>` regenerados en cascada (LLM). */
  interactionKeys: string[];
  estimateId: string | null;
  authorizationId: string | null;
  /** Monto autorizado para el upgrade (incremental) y presupuesto TOTAL del run resultante. */
  amount: string | null;
  authorizedRunBudget: string | null;
}

function asRecord(u: any): VideoUpgradeRecord | null {
  if (!u || typeof u !== 'object' || typeof u.id !== 'string' || !Array.isArray(u.itemKeys)) return null;
  return u as VideoUpgradeRecord;
}

/** `input_payload.videoUpgrade` (el ÚLTIMO upgrade) válido, o null. */
export function videoUpgradeOf(inputPayload: any): VideoUpgradeRecord | null {
  return asRecord(inputPayload?.videoUpgrade);
}

/** Todos los upgrades del run (historial + el último), del más viejo al más nuevo. */
export function videoUpgradesOf(inputPayload: any): VideoUpgradeRecord[] {
  const hist = Array.isArray(inputPayload?.videoUpgradeHistory) ? inputPayload.videoUpgradeHistory.map(asRecord).filter(Boolean) : [];
  const last = videoUpgradeOf(inputPayload);
  return last ? [...hist, last] : hist;
}

/** Keys de video de TODOS los upgrades del run. */
export function upgradedVideoKeysOf(inputPayload: any): Set<string> {
  return new Set(videoUpgradesOf(inputPayload).flatMap((u) => u.itemKeys));
}

/** Modo de video para items sin `output_summary.mode`: el ORIGINAL del run (antes de cualquier upgrade). */
export function fallbackVideoModeOf(inputPayload: any): unknown {
  return inputPayload?.videoModeOriginal ?? inputPayload?.videoMode;
}

/** ¿La generación es parte de un upgrade (video o sus interacciones)? */
export function isUpgradeGeneration(outputSummary: any): boolean {
  return VIDEO_UPGRADE_REASONS.includes(String(outputSummary?.regeneration?.reason ?? ''));
}

/** Estados finales de un run donde el §2.6 aplica. */
export const UPGRADE_DEGRADED_RUN_STATES = ['failed', 'cancelled'];

/** Huella del estimado del upgrade que vio el usuario (canónica, sha256). */
export function videoUpgradeFingerprint(input: {
  runId: string;
  manifestId: number;
  pending: Array<{ itemKey: string; generation: number }>;
  interactions: Array<{ itemKey: string; generation: number }>;
  /** Videos que reutilizan su job de Videogen (sin gasto nuevo); entra en la huella solo si hay. */
  carried?: string[];
  /** I-3: preguntas de videos reales ya pagados (solo LLM); entra en la huella solo si hay. */
  questionsOnly?: Array<{ itemKey: string; generation: number }>;
  modes: unknown;
  estimate: { estimatorVersion?: unknown; usageModelVersion?: unknown; pricingVersions?: unknown; totals: unknown };
  policyId: string | null;
  plan: { amount: string | null; withinPolicy: boolean };
  courseSpent: string;
  runActual: string;
  runPaidAuthorized: string | null;
}): string {
  const sortBy = (xs: Array<{ itemKey: string; generation: number }>) =>
    [...xs].sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0)).map((x) => [x.itemKey, x.generation]);
  const canon = JSON.stringify({
    v: 'video_upgrade_v1',
    runId: input.runId,
    manifestId: input.manifestId,
    pending: sortBy(input.pending),
    interactions: sortBy(input.interactions),
    ...(input.carried && input.carried.length ? { carried: [...input.carried].sort() } : {}),
    ...(input.questionsOnly && input.questionsOnly.length ? { questionsOnly: sortBy(input.questionsOnly) } : {}),
    modes: input.modes ?? null,
    estimatorVersion: input.estimate.estimatorVersion ?? null,
    usageModelVersion: input.estimate.usageModelVersion ?? null,
    pricingVersions: input.estimate.pricingVersions ?? null,
    totals: input.estimate.totals,
    policyId: input.policyId,
    plan: { amount: input.plan.amount, withinPolicy: input.plan.withinPolicy },
    courseSpent: input.courseSpent,
    runActual: input.runActual,
    runPaidAuthorized: input.runPaidAuthorized,
  });
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

/** Error de ruling 6 (mensaje estable con prefijo). */
export function videoModeInconsistentMessage(keys: string[], runId?: string): string {
  return (
    `${VIDEO_MODE_INCONSISTENT}: el run${runId ? ` ${runId}` : ''} está congelado en video real pero ` +
    `${keys.length === 1 ? 'el video' : 'los videos'} ${keys.join(', ')} ${keys.length === 1 ? 'es' : 'son'} de vista previa ` +
    'y no hay un upgrade registrado; no se empaqueta ni se ofrece generarlo otra vez (estado inconsistente: revisar).'
  );
}

export class VideoModeInconsistentError extends Error {
  readonly code = VIDEO_MODE_INCONSISTENT;
  constructor(readonly keys: string[], runId?: string) {
    super(videoModeInconsistentMessage(keys, runId));
  }
}

const TERMINAL_NOT_DONE = new Set(['failed', 'blocked', 'cancelled']);

/**
 * Fix round 3 (I-4) — procedencia EXPLÍCITA de las preguntas de un video. Toda generación de
 * `video_interactions` registra `output_summary.sourceVideoItemRunId` = item run de la generación
 * del video con la que se construyó (al crearla en un upgrade y, siempre, al reclamarla: el claim
 * resuelve el video vigente). Regla ÚNICA (empaque, planificador y — espejo — el frontend):
 * las preguntas son del video si y solo si están completadas y su `sourceVideoItemRunId` es la
 * generación vigente del video; filas anteriores sin el campo se aceptan si y solo si completaron
 * DESPUÉS de que completó esa generación del video.
 */
export function questionsBelongToVideo(
  video: { id: string; finishedAt?: unknown },
  questions: { status?: string | null; outputSummary?: any; finishedAt?: unknown } | null | undefined,
): boolean {
  if (!questions || questions.status !== 'completed') return false;
  const src = questions.outputSummary?.sourceVideoItemRunId;
  if (typeof src === 'string' && src) return src === video.id;
  const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN);
  const vf = ms(video.finishedAt);
  const qf = ms(questions.finishedAt);
  return Number.isFinite(vf) && Number.isFinite(qf) && qf >= vf;
}

/**
 * §2.6 — ¿el run terminó sin completar SOLO por items del upgrade de video? Recibe las filas de
 * la generación VIGENTE (más alta) de cada item que NO está completed, más el conjunto de keys
 * que tienen alguna generación completed. Pura.
 */
export function isUpgradeOnlyFailure(
  run: { worker_status?: string | null; status?: string | null; input_payload?: any },
  notCompletedLatest: ReadonlyArray<{ item_key: string; type: string; status: string; output_summary: any }>,
  keysWithCompletedGeneration: ReadonlySet<string>,
): boolean {
  const up = videoUpgradeOf(run?.input_payload);
  if (!up) return false;
  if (!UPGRADE_DEGRADED_RUN_STATES.includes(String(run?.worker_status ?? ''))) return false;
  if (notCompletedLatest.length === 0) return false;
  const upgraded = upgradedVideoKeysOf(run?.input_payload);
  for (const r of notCompletedLatest) {
    if (!TERMINAL_NOT_DONE.has(String(r.status))) return false;
    const reg = r.output_summary?.regeneration ?? {};
    const ok =
      (r.type === 'video' && reg.reason === VIDEO_UPGRADE_REASON && upgraded.has(r.item_key)) ||
      (r.type === 'video_interactions' && reg.reason === VIDEO_UPGRADE_CASCADE_REASON && upgraded.has(String(reg.cascadeFromItemKey ?? '')));
    if (!ok) return false;
    if (!keysWithCompletedGeneration.has(r.item_key)) return false;
  }
  return true;
}

type Q = { query: (sql: string, params?: any[]) => Promise<any> };

/** §2.6 con la DB: filas vigentes no completadas + keys con alguna generación completed. */
export async function runIsUpgradeOnlyFailure(q: Q, run: { id: string; worker_status?: string | null; status?: string | null; input_payload?: any }): Promise<boolean> {
  if (!videoUpgradeOf(run?.input_payload) || !UPGRADE_DEGRADED_RUN_STATES.includes(String(run?.worker_status ?? ''))) return false;
  const rows: any[] = await q.query(
    `select g.item_key, g.type, g.status, g.output_summary from public.generation_item_runs g
      where g.job_id = $1 and g.status <> 'completed'
        and not exists (select 1 from public.generation_item_runs n
                         where n.manifest_id = g.manifest_id and n.item_key = g.item_key and n.job_id = g.job_id and n.generation > g.generation)`,
    [run.id],
  );
  if (!rows.length) return false;
  const keys = [...new Set(rows.map((r) => r.item_key))];
  const done: any[] = await q.query(
    `select distinct item_key from public.generation_item_runs where job_id = $1 and status = 'completed' and item_key = any($2::text[])`,
    [run.id, keys],
  );
  const parse = (v: any) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : v ?? {});
  return isUpgradeOnlyFailure(run, rows.map((r) => ({ ...r, output_summary: parse(r.output_summary) })), new Set(done.map((d) => d.item_key)));
}
