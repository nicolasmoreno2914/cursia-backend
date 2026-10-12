import type { DataSource } from 'typeorm';
import type { ItemType } from './scheduler.service';

/**
 * Loop 4 (llamadas largas): partes de IA LARGAS que, con el worker de IA del backend habilitado, salen del navegador
 * y se generan en el servidor directo contra Anthropic (sin el límite de 100 s de Cloudflare ni depender de la
 * pestaña): Libro Guía (content), Actividades de Aplicación, SCORM (experience) y examen final.
 * Con el flag apagado (default) todo sigue exactamente como antes (el navegador las reclama).
 *
 * Review I7: el navegador solo deja de reclamar un tipo si además hay un worker de IA VIVO que lo cubre (latido en
 * public.llm_worker_presence). Un worker caído, en espera (sin flag / sin API key) o una tabla sin migrar → el
 * navegador sigue reclamándolo: el curso nunca queda colgado esperando a un worker que no está.
 */
export const LLM_WORKER_ENABLED_ENV = 'DYNAMIC_LLM_WORKER_ENABLED';
export const LLM_WORKER_TYPES_ENV = 'DYNAMIC_LLM_WORKER_TYPES';
/**
 * Loop 6 (activación segura): instante de activación (ISO). El worker de IA y el ruteo del navegador aplican SOLO a
 * runs creados desde entonces: ningún run anterior (ni uno pausado como #1209) se toma por accidente ni queda
 * esperando a un worker. Sin un instante válido no hay ruteo (lado seguro: el navegador sigue como siempre).
 */
export const LLM_WORKER_SINCE_ENV = 'DYNAMIC_LLM_WORKER_SINCE';
// Loop 6: + course_plan — en un L (20 capítulos) pide hasta 16 000 tokens de salida: en el navegador el proxy lo corta a
// 8000 y tarda > 100 s (524); en el worker no hay corte de tiempo y el tope es 16 000. Mismo prompt, mismo costo.
export const DEFAULT_LLM_WORKER_TYPES: readonly ItemType[] = ['course_plan', 'content', 'application_activity', 'experience', 'final_exam'] as ItemType[];

export function llmWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[LLM_WORKER_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
}

/** Instante de activación válido (ISO 8601 con fecha) o null. */
export function llmWorkerSince(env: Record<string, string | undefined> = process.env): Date | null {
  const raw = String(env[LLM_WORKER_SINCE_ENV] ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Ruteo activo = flag encendido + instante de activación válido. */
export function llmWorkerRoutingActive(env: Record<string, string | undefined> = process.env): boolean {
  return llmWorkerEnabled(env) && llmWorkerSince(env) !== null;
}

/** ¿El run (por su created_at) está alcanzado por el ruteo al worker de IA? */
export function runRoutedToLlmWorker(runCreatedAt: Date | string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const since = llmWorkerRoutingActive(env) ? llmWorkerSince(env) : null;
  if (!since || runCreatedAt === null || runCreatedAt === undefined) return false;
  const t = runCreatedAt instanceof Date ? runCreatedAt.getTime() : new Date(runCreatedAt).getTime();
  return Number.isFinite(t) && t >= since.getTime();
}

/**
 * Tipos que reclama el worker de IA (configurables; nunca uno fuera de los de IA del navegador). Un valor con algún
 * tipo desconocido es un error de configuración: lanza (el worker no arranca a medias con otro set de tipos).
 */
export function llmWorkerTypes(env: Record<string, string | undefined> = process.env, allowed: readonly string[] = DEFAULT_LLM_WORKER_TYPES): ItemType[] {
  const raw = String(env[LLM_WORKER_TYPES_ENV] ?? '').trim();
  if (!raw) return [...DEFAULT_LLM_WORKER_TYPES];
  const list = raw.split(',').map((t) => t.trim()).filter(Boolean);
  const bad = list.filter((t) => !allowed.includes(t));
  if (!list.length || bad.length) throw new Error(`${LLM_WORKER_TYPES_ENV} inválido (${bad.join(',') || 'vacío'}); permitidos: ${allowed.join(',')}`);
  return [...new Set(list)] as ItemType[];
}

/** Un latido más viejo que esto = worker muerto (el worker late cada LLM_WORKER_PRESENCE_BEAT_MS). */
export const LLM_WORKER_PRESENCE_FRESH_SECONDS = 60;
export const LLM_WORKER_PRESENCE_BEAT_MS = 15_000;
const PRESENCE_CACHE_MS = 5_000;
let presenceCache: { at: number; types: Set<string> } | null = null;

/**
 * Tipos cubiertos por algún worker de IA vivo (cache 5 s). Cualquier error → ninguno (el navegador sigue).
 * Un worker DRENANDO (deploy) sigue contando mientras su latido esté fresco (re-review N2): durante un deploy las
 * partes devueltas las toma el worker nuevo, nunca el navegador por el proxy de 100 s. Un worker muerto deja de
 * contar solo cuando su latido envejece (LLM_WORKER_PRESENCE_FRESH_SECONDS).
 */
export async function liveLlmWorkerTypes(ds: DataSource, now = Date.now()): Promise<Set<string>> {
  if (presenceCache && now - presenceCache.at < PRESENCE_CACHE_MS) return presenceCache.types;
  let types = new Set<string>();
  try {
    const rows: Array<{ t: string }> = await ds.query(
      `select distinct unnest(item_types) as t from public.llm_worker_presence
        where last_seen > now() - make_interval(secs => $1)`,
      [LLM_WORKER_PRESENCE_FRESH_SECONDS],
    );
    types = new Set(rows.map((r) => String(r.t)));
  } catch {
    types = new Set();
  }
  presenceCache = { at: now, types };
  return types;
}

export function resetLlmWorkerPresenceCacheForTests(): void {
  presenceCache = null;
}

/** Tipos que el NAVEGADOR puede reclamar hoy: con el flag del API y un worker de IA vivo, sin los que ese worker cubre. */
export function browserEffectiveTypes(types: readonly ItemType[], live: ReadonlySet<string>, env: Record<string, string | undefined> = process.env): ItemType[] {
  if (!llmWorkerEnabled(env)) return [...types];
  return types.filter((t) => !live.has(t));
}
