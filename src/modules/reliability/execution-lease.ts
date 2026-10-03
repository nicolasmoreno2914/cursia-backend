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

import { Logger } from '@nestjs/common';
import { returningRows } from '../../common/db/returning-rows';

const logger = new Logger('ExecutionLease');

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
  | { ok: true; expiresAt: string | null; skipped?: true }
  | { ok: false; expiresAt: string | null };

/** Postgres 42703 (undefined_column): las columnas del lease desaparecieron (rollback sin `pm2 reload`). */
export function isUndefinedColumnError(err: unknown): boolean {
  const e = err as { code?: unknown; driverError?: { code?: unknown } } | null;
  return !!e && (e.code === '42703' || e.driverError?.code === '42703');
}
let warnedMissing = false;
/**
 * Fix round 1 (m3): sin columnas a la hora de la consulta → se abre (sin lease, camino previo), se invalida
 * la sonda (el próximo claim ya no las usa) y se avisa UNA vez; nunca un 500.
 */
function failOpenOnMissingColumns(err: unknown): boolean {
  if (!isUndefinedColumnError(err)) return false;
  schemaCache = { ready: false, at: Date.now() };
  if (!warnedMissing) {
    warnedMissing = true;
    logger.warn('lease de ejecución: faltan las columnas de production_jobs (¿rollback sin pm2 reload?); se sigue sin lease (camino previo)');
  }
  return true;
}
/** Solo tests. */
export function resetExecLeaseWarnings(): void {
  warnedMissing = false;
}

/** Corre `fn` dentro de un SAVEPOINT (transacción en curso): una columna ausente no aborta la transacción. */
async function inSavepoint<T>(qr: Queryable, fn: () => Promise<T>, onMissing: () => T): Promise<T> {
  await qr.query('savepoint rel_exec_lease');
  try {
    const out = await fn();
    await qr.query('release savepoint rel_exec_lease');
    return out;
  } catch (err) {
    if (!failOpenOnMissingColumns(err)) throw err;
    await qr.query('rollback to savepoint rel_exec_lease');
    return onMissing();
  }
}

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
  return inSavepoint<ExecLeaseAcquire>(qr, async () => {
    // Una sentencia: el UPDATE condicional y, si no aplicó, el vencimiento vigente (instantánea previa).
    const [r] = await qr.query(
      `with upd as (
         update public.production_jobs
            set executor_lease_holder = $2,
                executor_lease_expires_at = now() + make_interval(secs => $3::int)
          where id = $1
            and (executor_lease_holder is null or executor_lease_expires_at is null
                 or executor_lease_expires_at <= now() or executor_lease_holder = $2)
          returning executor_lease_expires_at)
       select (select count(*)::int from upd) as taken,
              (select executor_lease_expires_at from upd) as new_exp,
              (select executor_lease_expires_at from public.production_jobs where id = $1) as cur_exp`,
      [jobId, executorId, ttlSeconds],
    );
    if (r && Number(r.taken) === 1) return { ok: true, expiresAt: iso(r.new_exp) };
    return { ok: false, expiresAt: iso(r?.cur_exp) };
  }, () => ({ ok: true, expiresAt: null, skipped: true }));
}

/**
 * Renueva el lease SOLO si `executorId` sigue siendo el titular (por id del run). Nota: un lease VENCIDO que
 * nadie tomó todavía sigue a nombre del titular, así que su próximo latido lo revive (intencional: nadie más
 * lo quería). Lo que no puede es recuperarlo después de que otro equipo lo tomó.
 * `inTx`: dentro de una transacción en curso (usa SAVEPOINT para que una columna ausente no la aborte).
 */
export async function refreshRunExecLease(q: Queryable, jobId: string, executorId: string, ttlSeconds: number, inTx = false): Promise<boolean> {
  const run = async () => {
    const rows = await q.query(
      `update public.production_jobs
          set executor_lease_expires_at = now() + make_interval(secs => $3::int)
        where id = $1 and executor_lease_holder = $2
        returning id`,
      [jobId, executorId, ttlSeconds],
    );
    return returningRows(rows).length === 1;
  };
  if (inTx) return inSavepoint(q, run, () => false);
  try {
    return await run();
  } catch (err) {
    if (failOpenOnMissingColumns(err)) return false;
    throw err;
  }
}

/** Liberación explícita del titular (dueño del run). Devuelve true si había lease de ese executorId. */
export async function releaseRunExecLease(q: Queryable, jobId: string, executorId: string, ownerId: string): Promise<boolean> {
  let rows: any;
  try {
    rows = await q.query(
    `update public.production_jobs
        set executor_lease_holder = null, executor_lease_expires_at = null
      where id = $1 and execution_mode = 'dynamic_generation' and owner_id = $3 and executor_lease_holder = $2
      returning id`,
      [jobId, executorId, ownerId],
    );
  } catch (err) {
    if (failOpenOnMissingColumns(err)) return false;
    throw err;
  }
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
