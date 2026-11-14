import type { DataSource } from 'typeorm';
import type { ItemType } from './scheduler.service';
import { PROVIDER_WORKER_ITEM_TYPES, workersHoldActive } from './workers-hold';
import { isProviderWorkerDeployed } from './provider-modes';

/**
 * Loop 4 (llamadas largas): partes de IA LARGAS que, con el worker de IA del backend habilitado, salen del navegador
 * y se generan en el servidor directo contra Anthropic (sin el límite de 100 s de Cloudflare ni depender de la
 * pestaña): Libro Guía (content), Actividades de Aplicación, SCORM (experience) y examen final. Loop 9: además todas
 * las partes de IA cortas (ALL_LLM_WORKER_TYPES), para que un run termine sin ninguna pestaña abierta.
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
// Loop 9 (autonomía): TODAS las partes de IA v3 van al worker por defecto (también las cortas: course_intro, module_intro,
// video_interactions, activity y exam). Sin esto un run no termina sin una pestaña abierta (audio_welcome depende de
// course_intro, video_interactions traba el cierre y el empaquetado automático solo corre con el run completado).
// Loop 9 B: + guided_practice (práctica guiada del capítulo). Nunca scorm (v1/v2) ni los tipos de proveedor. El navegador sigue de respaldo automático: solo deja de reclamar un tipo
// si un worker VIVO lo cubre (presencia).
export const ALL_LLM_WORKER_TYPES: readonly ItemType[] = [
  'course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'video_interactions', 'activity', 'application_activity', 'guided_practice', 'exam', 'final_exam',
] as ItemType[];
/** Loop 4/6: las partes LARGAS (las primeras que salieron del navegador). Se conserva como referencia. */
export const LONG_LLM_WORKER_TYPES: readonly ItemType[] = ['course_plan', 'content', 'application_activity', 'experience', 'final_exam'] as ItemType[];
export const DEFAULT_LLM_WORKER_TYPES: readonly ItemType[] = ALL_LLM_WORKER_TYPES;

export function llmWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[LLM_WORKER_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
}

/** Instante de activación válido (ISO 8601 con fecha) o null. */
export function llmWorkerSince(env: Record<string, string | undefined> = process.env): Date | null {
  const raw = String(env[LLM_WORKER_SINCE_ENV] ?? '').trim();
  // Review M3: con zona horaria explícita (Z u offset): nunca la hora local del proceso.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) return null;
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
export function llmWorkerTypes(env: Record<string, string | undefined> = process.env, allowed: readonly string[] = ALL_LLM_WORKER_TYPES): ItemType[] {
  const raw = String(env[LLM_WORKER_TYPES_ENV] ?? '').trim();
  if (!raw) return [...DEFAULT_LLM_WORKER_TYPES];
  const list = raw.split(',').map((t) => t.trim()).filter(Boolean);
  const bad = list.filter((t) => !allowed.includes(t));
  if (!list.length || bad.length) throw new Error(`${LLM_WORKER_TYPES_ENV} inválido (${bad.join(',') || 'vacío'}); permitidos: ${allowed.join(',')}`);
  return [...new Set(list)] as ItemType[];
}

export const LLM_WORKER_CONCURRENCY_ENV = 'DYNAMIC_LLM_WORKER_CONCURRENCY';
/** Loop 9: tope duro de partes de IA en paralelo en un worker (staging fija 4; un valor mayor se recorta). */
export const LLM_WORKER_MAX_CONCURRENCY = 6;
/** Partes de IA en paralelo (default 2). Inválido / ≤ 0 → default; > tope → tope. */
export function llmWorkerConcurrency(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env[LLM_WORKER_CONCURRENCY_ENV]);
  const n = Number.isFinite(v) && v > 0 ? Math.floor(v) : 2;
  return Math.min(n, LLM_WORKER_MAX_CONCURRENCY);
}

/** Un latido más viejo que esto = worker muerto (el worker late cada LLM_WORKER_PRESENCE_BEAT_MS). */
export const LLM_WORKER_PRESENCE_FRESH_SECONDS = 60;
export const LLM_WORKER_PRESENCE_BEAT_MS = 15_000;
const PRESENCE_CACHE_MS = 5_000;
let presenceCache: { at: number; types: Set<string> } | null = null;
let coverageCache: { at: number; coverage: LlmWorkerCoverage[] } | null = null;
let strictCoverageCache: { at: number; coverage: LlmWorkerCoverage[] } | null = null;
/** Loop 9 (fix M2): para AFIRMAR que el servidor genera todo, solo cuentan latidos de los últimos 2 intervalos (30 s). */
export const LLM_WORKER_PRESENCE_STRICT_SECONDS = Math.round((2 * LLM_WORKER_PRESENCE_BEAT_MS) / 1000);

/** Lo que cubre un worker de IA vivo: sus tipos y SU instante de activación (runs creados desde entonces). */
export interface LlmWorkerCoverage { types: Set<string>; since: Date }

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
  coverageCache = null;
  strictCoverageCache = null;
}

/**
 * Review I2: cobertura de los workers de IA vivos con el instante de activación que cada uno PUBLICA en su latido.
 * El API decide con eso (nunca con su propio env): si el API y el worker tuvieran instantes distintos, un run quedaría
 * sin dueño. Un worker sin instante publicado (versión anterior) no cubre nada. Cualquier error → sin cobertura.
 */
export async function liveLlmWorkerCoverage(ds: DataSource, now = Date.now(), freshSeconds = LLM_WORKER_PRESENCE_FRESH_SECONDS): Promise<LlmWorkerCoverage[]> {
  const strict = freshSeconds !== LLM_WORKER_PRESENCE_FRESH_SECONDS;
  const cache = strict ? strictCoverageCache : coverageCache;
  if (cache && now - cache.at < PRESENCE_CACHE_MS) return cache.coverage;
  let coverage: LlmWorkerCoverage[] = [];
  try {
    const rows: Array<{ item_types: string[]; since: Date | string | null }> = await ds.query(
      `select item_types, since from public.llm_worker_presence
        where since is not null and last_seen > now() - make_interval(secs => $1)`,
      [freshSeconds],
    );
    coverage = rows
      .map((r) => ({ types: new Set((r.item_types || []).map(String)), since: r.since instanceof Date ? r.since : new Date(String(r.since)) }))
      .filter((c) => !Number.isNaN(c.since.getTime()));
  } catch {
    coverage = [];
  }
  if (strict) strictCoverageCache = { at: now, coverage }; else coverageCache = { at: now, coverage };
  return coverage;
}

/** Tipos que un worker vivo cubre PARA ESTE RUN (creado desde su instante de activación). */
export function routedTypesForRun(coverage: readonly LlmWorkerCoverage[], runCreatedAt: Date | string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (runCreatedAt === null || runCreatedAt === undefined) return out;
  const t = runCreatedAt instanceof Date ? runCreatedAt.getTime() : new Date(runCreatedAt).getTime();
  if (!Number.isFinite(t)) return out;
  for (const c of coverage) if (t >= c.since.getTime()) for (const x of c.types) out.add(x);
  return out;
}

/** Tipos que el NAVEGADOR puede reclamar hoy: con el flag del API y un worker de IA vivo, sin los que ese worker cubre. */
export function browserEffectiveTypes(types: readonly ItemType[], live: ReadonlySet<string>, env: Record<string, string | undefined> = process.env): ItemType[] {
  if (!llmWorkerEnabled(env)) return [...types];
  return types.filter((t) => !live.has(t));
}

/**
 * Loop 9 (aviso «puedes cerrar la pestaña»): ¿el SERVIDOR genera todas las partes de IA de este run? Sí solo con el
 * flag del API encendido y un worker de IA VIVO que cubre, para este run (su instante de activación), cada tipo de IA
 * presente en el Manifest. `scorm` (v1/v2) nunca va al worker → un run con scorm nunca lo es. Worker caído / sin
 * latido / run anterior a la activación → false (la pestaña sigue haciendo falta).
 */
export function runServerExecuted(
  manifestItemTypes: readonly string[],
  routed: ReadonlySet<string>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!llmWorkerEnabled(env)) return false;
  const llm = [...new Set(manifestItemTypes.filter((t) => t === 'scorm' || (ALL_LLM_WORKER_TYPES as readonly string[]).includes(t)))];
  return llm.length > 0 && llm.every((t) => routed.has(t));
}

/**
 * r63 (UX, hallazgo 5): ¿el SERVIDOR ejecutará todo un run NUEVO de este Manifest? Se informa en la vista previa para que
 * el aviso de «cerrar la pestaña» no diga «mantén esta pestaña abierta» cuando no hace falta. Misma lógica que
 * `runServerExecuted` (cobertura viva estricta, creado «ahora» → posterior al instante de activación del worker), más:
 * solo Manifest v3, sin HOLD de workers y, si el Manifest tiene partes de proveedor (Gamma/TTS), con el worker de
 * proveedores desplegado. Ante cualquier duda → false (se mantiene el aviso de siempre, que es el seguro).
 */
export function previewServerExecution(
  manifestItemTypes: readonly string[],
  rulesVersion: number,
  coverage: readonly LlmWorkerCoverage[],
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (rulesVersion !== 3 || !llmWorkerEnabled(env) || workersHoldActive(env)) return false;
  if (manifestItemTypes.some((t) => PROVIDER_WORKER_ITEM_TYPES.includes(String(t))) && !isProviderWorkerDeployed(env)) return false;
  return runServerExecuted(manifestItemTypes, routedTypesForRun(coverage, new Date(now)), env);
}
