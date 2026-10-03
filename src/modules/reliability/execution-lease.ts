/**
 * REL — lease de EJECUCIÓN del navegador por run (server-authoritative).
 *
 * Separado a propósito del ACCESO al curso: abrir / ver / leer un curso o su run nunca consulta
 * este lease (cualquier equipo del dueño ve el progreso en vivo). El lease solo decide QUÉ ejecutor
 * del navegador puede reclamar partes de un run: uno a la vez por run.
 *
 * - Columnas (supabase-migration-rel-exec-lease.sql): production_jobs.executor_lease_holder (executorId
 *   del navegador, estable por equipo) y executor_lease_expires_at.
 * - El claim del navegador, con la fila del run bloqueada (FOR UPDATE), toma o renueva el lease si está
 *   libre, vencido o ya es de ese executorId; si no, el claim no entrega nada (`run_leased_elsewhere`).
 * - heartbeat / complete / fail del titular lo renuevan (solo si sigue siendo el titular: un ejecutor que
 *   perdió el lease no lo recupera por latir; su item en vuelo sigue con las reglas del lease por item).
 * - Se libera al terminar o cancelar el run (trigger de la migración, cualquier camino de escritura) o con
 *   una liberación explícita del titular (best-effort al cerrar la página; el vencimiento es la garantía).
 * - Los workers del servidor (video / Gamma / TTS / empaque) nunca lo miran.
 *
 * Sin la migración (sonda negativa) todo esto es no-op y el claim se comporta como antes.
 */

import { returningRows } from '../../common/db/returning-rows';

export const EXEC_LEASE_RUN_LEASED_ELSEWHERE = 'run_leased_elsewhere';

interface Queryable {
  query(sql: string, params?: any[]): Promise<any>;
}

const NEGATIVE_TTL_MS = 60_000;
const POSITIVE_TTL_MS = 5 * 60_000;
let schemaCache: { ready: boolean; at: number } | null = null;

/** Solo tests: olvida la sonda. */
export function resetExecLeaseSchemaCache(): void {
  schemaCache = null;
}

/** ¿Existen las columnas del lease? Solo lectura, nunca falla, segura dentro de una transacción. */
export async function execLeaseSchemaReady(q: Queryable, now: number = Date.now()): Promise<boolean> {
  if (schemaCache && now - schemaCache.at < (schemaCache.ready ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return schemaCache.ready;
  const rows = await q.query(
    `select count(*)::int = 2 as ready from information_schema.columns
      where table_schema = 'public' and table_name = 'production_jobs'
        and column_name in ('executor_lease_holder', 'executor_lease_expires_at')`,
  );
  const ready = !!(Array.isArray(rows) ? rows[0]?.ready : false);
  schemaCache = { ready, at: now };
  return ready;
}

export type ExecLeaseAcquire =
  | { ok: true; expiresAt: string | null }
  | { ok: false; expiresAt: string | null };

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Toma o renueva el lease del run para `executorId`. Llamar con la fila del run YA bloqueada
 * (FOR UPDATE) en la misma transacción: la decisión es atómica con el claim del item.
 */
export async function acquireRunExecLease(qr: Queryable, jobId: string, executorId: string, ttlSeconds: number): Promise<ExecLeaseAcquire> {
  const rows = await qr.query(
    `update public.production_jobs
        set executor_lease_holder = $2,
            executor_lease_expires_at = now() + make_interval(secs => $3::int)
      where id = $1
        and (executor_lease_holder is null or executor_lease_expires_at is null
             or executor_lease_expires_at <= now() or executor_lease_holder = $2)
      returning executor_lease_expires_at`,
    [jobId, executorId, ttlSeconds],
  );
  const got = returningRows(rows);
  if (got.length) return { ok: true, expiresAt: iso(got[0].executor_lease_expires_at) };
  const [cur] = await qr.query(`select executor_lease_expires_at from public.production_jobs where id = $1`, [jobId]);
  return { ok: false, expiresAt: iso(cur?.executor_lease_expires_at) };
}

/** Renueva el lease SOLO si `executorId` sigue siendo el titular (por id del run). */
export async function refreshRunExecLease(q: Queryable, jobId: string, executorId: string, ttlSeconds: number): Promise<boolean> {
  const rows = await q.query(
    `update public.production_jobs
        set executor_lease_expires_at = now() + make_interval(secs => $3::int)
      where id = $1 and executor_lease_holder = $2
      returning id`,
    [jobId, executorId, ttlSeconds],
  );
  return returningRows(rows).length === 1;
}

/** Liberación explícita del titular (dueño del run). Devuelve true si había lease de ese executorId. */
export async function releaseRunExecLease(q: Queryable, jobId: string, executorId: string, ownerId: string): Promise<boolean> {
  const rows = await q.query(
    `update public.production_jobs
        set executor_lease_holder = null, executor_lease_expires_at = null
      where id = $1 and execution_mode = 'dynamic_generation' and owner_id = $3 and executor_lease_holder = $2
      returning id`,
    [jobId, executorId, ownerId],
  );
  return returningRows(rows).length === 1;
}

export interface ExecutionLeaseView {
  /** Un ejecutor del navegador tiene el lease vigente de este run. */
  held: boolean;
  /** …y es el `executorId` que hizo la consulta (este equipo). */
  heldByYou: boolean;
  /** Vencimiento del lease vigente (null si nadie lo tiene). */
  expiresAt: string | null;
}

/**
 * Vista del lease para el RunDto (pura). null si la fila no trae las columnas (sin migración).
 * Un run no activo nunca tiene lease vigente.
 */
export function executionLeaseView(
  job: Record<string, any>,
  requestingExecutorId: string | null | undefined,
  runActive: boolean,
  now: Date = new Date(),
): ExecutionLeaseView | null {
  if (!job || !('executor_lease_holder' in job) || !('executor_lease_expires_at' in job)) return null;
  const holder = job.executor_lease_holder ? String(job.executor_lease_holder) : null;
  const exp = iso(job.executor_lease_expires_at);
  const held = runActive && !!holder && !!exp && new Date(exp).getTime() > now.getTime();
  if (!held) return { held: false, heldByYou: false, expiresAt: null };
  return { held: true, heldByYou: !!requestingExecutorId && requestingExecutorId === holder, expiresAt: exp };
}

/** executorId de consulta válido (mismo tope que el DTO del ejecutor) o null. */
export function normalizeRequestingExecutorId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 200 ? s : null;
}
