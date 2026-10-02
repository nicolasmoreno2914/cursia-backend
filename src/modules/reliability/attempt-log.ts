// ─────────────────────────────────────────────────────────────────────────────
// REL R2 — registro de intentos (`generation_item_attempts`) y columnas de recuperación de
// `generation_item_runs` (failure_class/failure_code/recovery_*/cooldown_until/attention_reason).
//
// - Cada escritura corre con el QueryRunner del CALLER, dentro de la MISMA transacción que la
//   transición de estado del item (claim / complete / fail / barrido de leases / drain / reapertura /
//   cancelación): o quedan las dos o ninguna.
// - Esquema TOLERADO: el código puede llegar a un entorno sin la migración
//   (supabase-migration-rel-recovery.sql). Una sonda única por proceso (positiva cacheada para
//   siempre, negativa 60 s) decide; sin esquema todo es no-op y el comportamiento es idéntico al de
//   antes. Nunca se ejecuta un statement que pueda fallar por columna/tabla ausente dentro de la
//   transacción del caller (en Postgres un error la abortaría entera).
// - Solo REGISTRA. Ninguna decisión de recuperación lee estas columnas todavía (eso es R3).
// ─────────────────────────────────────────────────────────────────────────────
import { returningRows } from '../../common/db/returning-rows';
import type { FailureVerdict } from './failure-classifier';

export type AttemptOutcome = 'completed' | 'failed' | 'lease_expired' | 'drained' | 'abandoned' | 'reopened';
export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = Object.freeze(['completed', 'failed', 'lease_expired', 'drained', 'abandoned', 'reopened'] as AttemptOutcome[]);

export type ExecutorKind = 'browser' | 'server_llm' | 'video_worker' | 'provider_worker' | 'package_worker' | 'restore_worker';

/** Quién reabrió: sistema (auto-heal / reintento seguro), un admin (hash del email) o el dueño. */
export type AttemptActor = 'system' | 'auto_heal' | 'recovery' | 'owner' | `admin:${string}`;

export const ERROR_EXCERPT_MAX = 500;

interface Queryable {
  query(sql: string, params?: any[]): Promise<any>;
}

// ─── Sonda de esquema ────────────────────────────────────────────────────────

const NEGATIVE_TTL_MS = 60_000;
let schemaCache: { ready: boolean; at: number } | null = null;

/** Solo tests: olvida la sonda. */
export function resetRelSchemaCache(): void {
  schemaCache = null;
}

/**
 * ¿Existe el esquema de R2? Una consulta de solo lectura que nunca falla (to_regclass /
 * information_schema), segura dentro de cualquier transacción.
 */
export async function relSchemaReady(q: Queryable, now: number = Date.now()): Promise<boolean> {
  if (schemaCache && (schemaCache.ready || now - schemaCache.at < NEGATIVE_TTL_MS)) return schemaCache.ready;
  const rows = await q.query(
    `select (to_regclass('public.generation_item_attempts') is not null
             and exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'generation_item_runs'
                            and column_name = 'recovery_round')) as ready`,
  );
  const ready = !!(Array.isArray(rows) ? rows[0]?.ready : false);
  schemaCache = { ready, at: now };
  return ready;
}

// ─── Utilidades puras ────────────────────────────────────────────────────────

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_\-]{8,}/g, 'sk-[redacted]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '[jwt-redacted]'],
  [/([?&](?:key|api_key|apikey|token|access_token|signature|sig|X-Amz-Signature|X-Amz-Credential)=)[^&\s]+/gi, '$1[redacted]'],
  [/\b((?:api[_-]?key|x-api-key|authorization|password|secret)\s*[:=]\s*)["']?[^\s"',;]{6,}/gi, '$1[redacted]'],
];

/** Extracto del error para el log de intentos: ≤ 500 caracteres y sin secretos. */
export function redactErrorExcerpt(error: unknown): string | null {
  const s = String(error ?? '').trim();
  if (!s) return null;
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out.length > ERROR_EXCERPT_MAX ? out.slice(0, ERROR_EXCERPT_MAX - 1) + '…' : out;
}

/** Tipos que ejecuta cada worker (mismo reparto que WORKER_ONLY_TYPES del scheduler). */
const PROVIDER_WORKER_TYPES = new Set(['presentation', 'audio_welcome', 'audiobook_chapter']);

/** Quién ejecuta este intento: el navegador (ownerId presente) o el worker del tipo. */
export function executorKindFor(itemType: string, browser: boolean): ExecutorKind {
  if (browser) return 'browser';
  if (itemType === 'video') return 'video_worker';
  if (PROVIDER_WORKER_TYPES.has(itemType)) return 'provider_worker';
  return 'server_llm';
}

/** Versión del proceso que ejecuta (sha del build si el deploy la expone). */
export function workerVersion(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.CURSIA_BUILD_SHA || env.GIT_SHA || env.GITHUB_SHA || null;
  return v ? String(v).slice(0, 64) : null;
}

/** Desenlace del intento según el código del fallo. */
export function outcomeForFailure(code: string): AttemptOutcome {
  if (code === 'lease_expired') return 'lease_expired';
  if (code === 'worker_draining') return 'drained';
  return 'failed';
}

/** Hash corto y estable de un email de admin para `actor` (nunca el email en claro). */
export function adminActor(emailOrId: string | null | undefined): AttemptActor {
  const s = String(emailOrId ?? '').trim().toLowerCase();
  // FNV-1a 32 bits: suficiente para distinguir actores en un log, no es un secreto.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `admin:${h.toString(16).padStart(8, '0')}`;
}

// ─── Escrituras (dentro de la transacción del caller) ───────────────────────

/** Cierra intentos que quedaron abiertos (código viejo, transición perdida) antes de abrir/registrar otro. */
async function closeDangling(qr: Queryable, itemRunId: string, outcome: AttemptOutcome): Promise<void> {
  await qr.query(
    `update public.generation_item_attempts
        set finished_at = now(), outcome = $2
      where item_run_id = $1 and finished_at is null`,
    [itemRunId, outcome],
  );
}

export interface ClaimedRowLike {
  id: string;
  job_id: string;
  course_id: number | null;
  item_key: string;
  generation: number;
  type: string;
  attempt_count: number;
  recovery_round?: number | null;
  claimed_at?: Date | string | null;
}

/** Claim: abre el intento (attempt_no = attempt_count ya incrementado). */
export async function openItemAttempt(
  qr: Queryable,
  row: ClaimedRowLike,
  opts: { executorKind: ExecutorKind; executorId: string; bundleSha?: string | null },
): Promise<void> {
  if (!(await relSchemaReady(qr))) return;
  await closeDangling(qr, row.id, 'abandoned');
  await qr.query(
    `insert into public.generation_item_attempts
       (item_run_id, job_id, course_id, item_key, generation, attempt_no, executor_kind, executor_id, bundle_sha,
        worker_version, started_at, heartbeat_at, recovery_round, actor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now(),
             coalesce((select recovery_round from public.generation_item_runs where id = $1), 0), 'system')`,
    [row.id, row.job_id, row.course_id ?? null, row.item_key, Number(row.generation), Number(row.attempt_count),
      opts.executorKind, String(opts.executorId).slice(0, 200), opts.bundleSha ?? null, workerVersion()],
  );
}

/** Complete: cierra el intento y limpia el último fallo del item (failure_class null = sin fallo). */
export async function recordItemCompleted(qr: Queryable, itemRunId: string): Promise<void> {
  if (!(await relSchemaReady(qr))) return;
  await qr.query(
    `update public.generation_item_runs
        set failure_class = null, failure_code = null, recovery_strategy = null,
            cooldown_until = null, attention_reason = null
      where id = $1`,
    [itemRunId],
  );
  await qr.query(
    `update public.generation_item_attempts
        set finished_at = now(), outcome = 'completed'
      where item_run_id = $1 and finished_at is null`,
    [itemRunId],
  );
}

export interface FailureTransition {
  itemRunId: string;
  /** Estado resultante del item (retrying | failed | blocked). */
  status: string;
  error: string;
  verdict: FailureVerdict;
  /** Rondas automáticas que el sistema hará HOY (auto-heal / reintento seguro); 0 = ninguna. */
  maxRoundsToday: number;
  outcome?: AttemptOutcome;
}

/**
 * Fail / barrido de leases / drain / runtime guard de presupuesto: columnas de recuperación del item
 * + cierre del intento abierto (o, si el claim fue anterior a la migración, un intento ya cerrado).
 */
export async function recordItemFailure(qr: Queryable, t: FailureTransition): Promise<void> {
  if (!(await relSchemaReady(qr))) return;
  const v = t.verdict;
  const terminal = t.status === 'failed' || t.status === 'blocked';
  // attention_reason solo cuando el item quedó en manos de un humano (clase C/D terminal).
  const attention = terminal && (v.class === 'C' || v.class === 'D') ? (v.humanReason ?? 'unrecoverable') : null;
  const outcome = t.outcome ?? outcomeForFailure(v.code);
  await qr.query(
    `update public.generation_item_runs
        set failure_class = $2, failure_code = $3, recovery_strategy = $4, recovery_max_rounds = $5,
            attention_reason = $6
      where id = $1`,
    [t.itemRunId, v.class, v.code, v.strategy, Math.max(0, Math.floor(t.maxRoundsToday)), attention],
  );
  const closed = returningRows(await qr.query(
    `update public.generation_item_attempts a
        set finished_at = now(), outcome = $2, failure_class = $3, failure_code = $4, error_excerpt = $5,
            http_status = $6, provider = $7, strategy_applied = $8,
            next_retry_at = (select g.next_retry_at from public.generation_item_runs g where g.id = a.item_run_id)
      where a.item_run_id = $1 and a.finished_at is null
      returning a.id`,
    [t.itemRunId, outcome, v.class, v.code, redactErrorExcerpt(t.error), v.httpStatus ?? null, v.provider ?? null, v.strategy],
  ));
  if (closed.length > 0) return;
  await qr.query(
    `insert into public.generation_item_attempts
       (item_run_id, job_id, course_id, item_key, generation, attempt_no, executor_kind, executor_id, worker_version,
        started_at, finished_at, outcome, failure_class, failure_code, error_excerpt, http_status, provider,
        strategy_applied, next_retry_at, recovery_round, actor)
     select g.id, g.job_id, g.course_id, g.item_key, g.generation, g.attempt_count, null, null, $9,
            coalesce(g.claimed_at, now()), now(), $2, $3, $4, $5, $6, $7, $8, g.next_retry_at, g.recovery_round, 'system'
       from public.generation_item_runs g where g.id = $1`,
    [t.itemRunId, outcome, v.class, v.code, redactErrorExcerpt(t.error), v.httpStatus ?? null, v.provider ?? null, v.strategy, workerVersion()],
  );
}

/**
 * Reapertura (retry del dueño/admin, auto-heal, reintento seguro, resolución de YouTube, reapertura
 * del run, nueva generación): fila `reopened` + ronda de recuperación del item. El último fallo
 * (failure_class/code) se conserva como «último error» hasta que el item se complete.
 */
export async function recordItemReopened(
  qr: Queryable,
  itemRunId: string,
  /** automatic: reapertura del sistema (auto-heal / reintento seguro) → recovery_round + 1. */
  opts: { actor: AttemptActor; strategy: string; automatic?: boolean },
): Promise<void> {
  if (!(await relSchemaReady(qr))) return;
  await closeDangling(qr, itemRunId, 'abandoned');
  await qr.query(
    `update public.generation_item_runs
        set recovery_round = recovery_round + case when $2::boolean then 1 else 0 end,
            attention_reason = null, cooldown_until = null
      where id = $1`,
    [itemRunId, !!opts.automatic],
  );
  await qr.query(
    `insert into public.generation_item_attempts
       (item_run_id, job_id, course_id, item_key, generation, attempt_no, worker_version, started_at, finished_at,
        outcome, failure_class, failure_code, strategy_applied, next_retry_at, recovery_round, actor)
     select g.id, g.job_id, g.course_id, g.item_key, g.generation, g.attempt_count, $4, now(), now(),
            'reopened', g.failure_class, g.failure_code, $3, g.next_retry_at, g.recovery_round, $2
       from public.generation_item_runs g where g.id = $1`,
    [itemRunId, opts.actor, String(opts.strategy).slice(0, 64), workerVersion()],
  );
}

/** Cancelación del run: los intentos abiertos de esos items quedan `abandoned`. */
export async function recordItemsAbandoned(qr: Queryable, itemRunIds: string[]): Promise<void> {
  if (!itemRunIds.length || !(await relSchemaReady(qr))) return;
  await qr.query(
    `update public.generation_item_attempts
        set finished_at = now(), outcome = 'abandoned'
      where item_run_id = any($1::uuid[]) and finished_at is null`,
    [itemRunIds],
  );
}
