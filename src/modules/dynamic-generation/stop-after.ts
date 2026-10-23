import { BadRequestException } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';
import { latestGenerationPredicate } from './item-generations';
import { returningRows } from '../../common/db/returning-rows';

/**
 * «Detener después de» por run (2026-10-14, validación real #1353): el servidor pausa el run en la MISMA
 * transacción en que se completa una parte elegida, y opcionalmente retiene el empaque automático.
 * Reemplaza al observador del navegador (una pestaña que sondeaba cada 2 s y pausaba a mano): el worker
 * reclamó la parte siguiente ~10 s después de completarse la elegida, antes de que la pausa llegara.
 *
 * Config en `production_jobs.output_summary.stopAfter` (jsonb, sin migración):
 *   { itemKeys: string[], holdPackaging: boolean, setAt, setBy, firedAt: null | ts, firedItemKey: null | key }
 *
 * - Disparo (`applyStopAfterInTx`, desde `recomputeRunStatus`, con la fila del run YA bloqueada por el caller):
 *   si alguna de `itemKeys` tiene su generación vigente `completed`, la config no disparó todavía y el run es
 *   DESPACHABLE → pasa a `paused` (reason `stop_after_item`) y se marca `firedAt`/`firedItemKey`, todo en un UPDATE.
 *   Ningún claim posterior entrega partes: `claimInRun` bloquea la misma fila y rechaza un run pausado. Las partes
 *   que ya estaban en vuelo terminan o, si necesitan otra llamada de IA, el guard del servidor (run_paused) las
 *   devuelve a la cola sin consumir intento y con sus checkpoints pagados intactos.
 *   Review I1: si el run ya estaba pausado por OTRA causa (usuario, `run_budget_cap`, disyuntor) se respeta esa
 *   pausa y la config sigue ARMADA (sin `firedAt`): la primera reanudación (resumeRun recalcula en su misma
 *   transacción) vuelve a pausar con `stop_after_item`; recién la siguiente reanudación sigue.
 * - Un disparo por config (review M4): una vez disparada, regenerar más tarde la misma parte no vuelve a pausar;
 *   para eso se vuelve a configurar (PUT). Si el run se CIERRA (completed/preview) con la config todavía armada, queda
 *   vencida (`firedAt` + `expiredAt`, review r2 N1): una reapertura posterior nunca dispara una pausa tardía.
 * - API (review M7): DELETE es idempotente en cualquier estado; release sobre un run todavía en curso solo apaga la
 *   retención (al completarse, el empaque automático de siempre).
 * - Retención del empaque (`holdPackaging`): cuando el run pasa a `completed` con la config vigente, NO se marca
 *   `autoPackage.eligibleAt` ni se avisa a los oyentes post-commit (el empaque automático, su barrido y su
 *   reparación por item solo actúan sobre runs con esa marca). Queda `autoPackage.held`. El paquete se arma solo
 *   por una acción explícita: «Preparar paquete» (manual, el mismo de siempre) o `releasePackageHold`.
 * - Por run: nunca toca la variable global DYNAMIC_AUTO_PACKAGE_ENABLED ni a otros runs.
 */
export const STOP_AFTER_PAUSE_REASON = 'stop_after_item';
export const STOP_AFTER_MAX_KEYS = 20;
/** Motivo de la retención cuando la config solo retiene el empaque (sin partes que detengan el run). */
export const PACKAGE_HOLD_ONLY_REASON = 'package_hold';

export interface StopAfterConfig {
  itemKeys: string[];
  holdPackaging: boolean;
  setAt: string | null;
  setBy: string | null;
  firedAt: string | null;
  firedItemKey: string | null;
}

/** Vista pública (RunDto): sin `setBy`. */
export interface StopAfterView {
  itemKeys: string[];
  holdPackaging: boolean;
  setAt: string | null;
  firedAt: string | null;
  firedItemKey: string | null;
}

export interface StopAfterBody {
  itemKeys: string[];
  holdPackaging: boolean;
}

const ITEM_KEY_RE = /^[a-z_]+:[A-Za-z0-9_-]{1,80}$/;
const ALLOWED = new Set(['itemKeys', 'holdPackaging']);

function objOf(v: unknown): Record<string, any> {
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : v instanceof Date ? v.toISOString() : null;
}

/**
 * Body de `PUT …/runs/:runId/stop-after` — `{ itemKeys: string[], holdPackaging?: boolean }`, validado A MANO
 * (mismo criterio que regenerate-item.dto.ts: con la conversión implícita un `"false"` sería `true`).
 * `itemKeys` vacío solo vale con `holdPackaging: true` (retener el empaque sin detener el run).
 */
export function parseStopAfterBody(body: unknown): StopAfterBody {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('El body debe ser un objeto JSON {"itemKeys": ["final_exam:<id>"], "holdPackaging": true}');
  }
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (extra.length > 0) throw new BadRequestException(extra.map((k) => `property ${k} should not exist`).join('; '));
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.itemKeys)) throw new BadRequestException('itemKeys debe ser una lista de claves de parte (p.ej. "final_exam:123")');
  if (b.itemKeys.length > STOP_AFTER_MAX_KEYS) throw new BadRequestException(`itemKeys admite hasta ${STOP_AFTER_MAX_KEYS} claves`);
  const keys: string[] = [];
  for (const k of b.itemKeys) {
    if (typeof k !== 'string' || !ITEM_KEY_RE.test(k)) throw new BadRequestException(`clave de parte inválida: ${JSON.stringify(k).slice(0, 100)}`);
    if (!keys.includes(k)) keys.push(k);
  }
  if (b.holdPackaging !== undefined && typeof b.holdPackaging !== 'boolean') {
    throw new BadRequestException('holdPackaging debe ser un booleano');
  }
  const holdPackaging = b.holdPackaging === true;
  if (keys.length === 0 && !holdPackaging) {
    throw new BadRequestException('itemKeys vacío solo tiene sentido con holdPackaging: true (para quitar la configuración: DELETE)');
  }
  return { itemKeys: keys, holdPackaging };
}

/** Config vigente del run (saneada) o null. */
export function stopAfterOf(job: { output_summary?: unknown } | null | undefined): StopAfterConfig | null {
  const s = objOf(objOf(job?.output_summary).stopAfter);
  if (!Array.isArray(s.itemKeys)) return null;
  const itemKeys = s.itemKeys.filter((k: unknown) => typeof k === 'string' && ITEM_KEY_RE.test(k)).slice(0, STOP_AFTER_MAX_KEYS);
  const holdPackaging = s.holdPackaging === true;
  if (itemKeys.length === 0 && !holdPackaging) return null;
  return {
    itemKeys,
    holdPackaging,
    setAt: str(s.setAt),
    setBy: str(s.setBy),
    firedAt: str(s.firedAt),
    firedItemKey: typeof s.firedItemKey === 'string' ? s.firedItemKey : null,
  };
}

export function stopAfterView(job: { output_summary?: unknown } | null | undefined): StopAfterView | null {
  const c = stopAfterOf(job);
  if (!c) return null;
  return { itemKeys: c.itemKeys, holdPackaging: c.holdPackaging, setAt: c.setAt, firedAt: c.firedAt, firedItemKey: c.firedItemKey };
}

/** Empaque automático retenido por esta config (run completado con `autoPackage.held`) o null. */
export function packageHoldOf(job: { output_summary?: unknown } | null | undefined): { heldAt: string | null; reason: string | null } | null {
  const ap = objOf(objOf(job?.output_summary).autoPackage);
  const h = objOf(ap.held);
  if (!Object.keys(h).length || ap.eligibleAt) return null;
  return { heldAt: str(h.at), reason: typeof h.reason === 'string' ? h.reason : null };
}

/** ¿La retención del empaque está vigente en este run (config con holdPackaging)? */
export function holdsPackaging(job: { output_summary?: unknown } | null | undefined): boolean {
  return stopAfterOf(job)?.holdPackaging === true;
}

/** Motivo registrado en `autoPackage.held` (review M2): con partes → stop_after_item; solo retención → package_hold. */
export function packageHoldReason(job: { output_summary?: unknown } | null | undefined): string {
  return (stopAfterOf(job)?.itemKeys.length ?? 0) > 0 ? STOP_AFTER_PAUSE_REASON : PACKAGE_HOLD_ONLY_REASON;
}

/**
 * Disparo del «detener después de» (ver cabecera). Fila del run YA bloqueada (FOR UPDATE) por el caller.
 * Devuelve true si pausó el run en esta llamada.
 */
export async function applyStopAfterInTx(
  qr: QueryRunner,
  job: { id: string; status?: string | null; worker_status?: string | null; output_summary?: unknown },
): Promise<boolean> {
  const cfg = stopAfterOf(job);
  if (!cfg || cfg.firedAt || cfg.itemKeys.length === 0) return false;
  const [hit] = await qr.query(
    `select g.item_key from public.generation_item_runs g
      where g.job_id = $1 and g.item_key = any($2::text[]) and g.status = 'completed' and ${latestGenerationPredicate('g')}
      order by g.finished_at nulls last, g.item_key
      limit 1`,
    [job.id, cfg.itemKeys],
  );
  if (!hit) return false;
  const key = String(hit.item_key);
  // Review I1: solo se dispara cuando la pausa se aplica (run despachable); si no, la config sigue armada.
  const rows = await qr.query(
    `update public.production_jobs
        set status = 'paused', worker_status = 'paused', next_retry_at = null,
            output_summary = jsonb_set(
              coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                'pause', jsonb_build_object('pausedAt', now(), 'pausedBy', 'system:' || $3::text, 'reason', $3::text,
                                            'detail', $2::text, 'previousWorkerStatus', worker_status)),
              '{stopAfter}',
              coalesce(output_summary->'stopAfter', '{}'::jsonb) || jsonb_build_object('firedAt', now(), 'firedItemKey', $4::text),
              true),
            updated_at = now()
      where id = $1 and worker_status in ('queued', 'running', 'retrying') and coalesce(status, '') not in ('cancelled', 'cancelling')
      returning id`,
    [job.id, `${key} completada`.slice(0, 500), STOP_AFTER_PAUSE_REASON, key],
  );
  return returningRows(rows).length === 1;
}

/**
 * T8 (factory mode, 2026-10-18) — retención del empaque POR DEFECTO para owners configurados.
 *
 * `DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS`: UUIDs de owner separados por coma (o `*` = todos). Los runs NUEVOS de esos
 * owners nacen con `stopAfter = {itemKeys: [], holdPackaging: true, setBy: 'system:default_hold_packaging'}` — lo
 * mismo que el `PUT …/stop-after {"itemKeys":[],"holdPackaging":true}` que el operador hacía a mano tras «Autorizar
 * y generar». El paquete se arma solo por acción explícita («Preparar paquete» / `releasePackageHold`); el dueño
 * puede quitar la retención con DELETE como siempre. Ausente / vacía → ningún run cambia (default).
 * Se lee de `process.env` en cada llamada (sin caché). Una entrada que no es UUID ni `*` se ignora con aviso (la
 * lista nunca bloquea el arranque de un run).
 * r62 (d14): es una herramienta de MODO FÁBRICA, apagada por defecto. Ni deploy.yml ni deploy-staging.yml la escriben
 * (staging solo AVISA en el deploy si alguien la dejó a mano en el .env); en operación normal ningún run nace retenido
 * y el empaque final se arma solo. Un run retenido así lo muestra en `stopAfter.setBy = system:default_hold_packaging`.
 */
export const DEFAULT_HOLD_PACKAGING_OWNERS_ENV = 'DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS';
export const DEFAULT_HOLD_PACKAGING_SET_BY = 'system:default_hold_packaging';
const OWNER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿Los runs nuevos de este owner nacen con el empaque retenido? (puro) */
export function defaultHoldPackagingFor(ownerId: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const raw = String(env[DEFAULT_HOLD_PACKAGING_OWNERS_ENV] ?? '').trim();
  if (!raw) return false;
  const entries = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (entries.includes('*')) return true;
  const owner = String(ownerId ?? '').trim().toLowerCase();
  if (!owner) return false;
  return entries.some((e) => OWNER_UUID_RE.test(e) && e === owner);
}

/** Entradas inválidas de la lista (para el aviso de configuración). */
export function invalidDefaultHoldPackagingEntries(env: Record<string, string | undefined> = process.env): string[] {
  return String(env[DEFAULT_HOLD_PACKAGING_OWNERS_ENV] ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .filter((e) => e !== '*' && !OWNER_UUID_RE.test(e));
}

/**
 * `output_summary` inicial de un run nuevo: `{stopAfter: …}` con la retención por defecto, o `{}` (sin cambios).
 * `base` se conserva (p.ej. `invalidation` de un run derivado).
 */
export function initialRunOutputSummary(
  ownerId: string | null | undefined,
  base: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Record<string, unknown> {
  if (!defaultHoldPackagingFor(ownerId, env)) return { ...base };
  return {
    ...base,
    stopAfter: { itemKeys: [], holdPackaging: true, setAt: now.toISOString(), setBy: DEFAULT_HOLD_PACKAGING_SET_BY, firedAt: null, firedItemKey: null },
  };
}
