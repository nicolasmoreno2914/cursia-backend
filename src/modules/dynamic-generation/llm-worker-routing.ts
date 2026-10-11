import type { ItemType } from './scheduler.service';

/**
 * Loop 4 (llamadas largas): partes de IA LARGAS que, con el worker de IA del backend habilitado, salen del navegador
 * y se generan en el servidor directo contra Anthropic (sin el límite de 100 s de Cloudflare ni depender de la
 * pestaña): Libro Guía (content), Actividades de Aplicación, SCORM (experience) y examen final.
 * Con el flag apagado (default) todo sigue exactamente como antes (el navegador las reclama).
 */
export const LLM_WORKER_ENABLED_ENV = 'DYNAMIC_LLM_WORKER_ENABLED';
export const LLM_WORKER_TYPES_ENV = 'DYNAMIC_LLM_WORKER_TYPES';
export const DEFAULT_LLM_WORKER_TYPES: readonly ItemType[] = ['content', 'application_activity', 'experience', 'final_exam'] as ItemType[];

export function llmWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[LLM_WORKER_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
}

/** Tipos que reclama el worker de IA (configurables; nunca uno fuera de los de IA del navegador). */
export function llmWorkerTypes(env: Record<string, string | undefined> = process.env, allowed: readonly string[] = DEFAULT_LLM_WORKER_TYPES): ItemType[] {
  const raw = String(env[LLM_WORKER_TYPES_ENV] ?? '').trim();
  if (!raw) return [...DEFAULT_LLM_WORKER_TYPES];
  return raw.split(',').map((t) => t.trim()).filter((t) => t && allowed.includes(t)) as ItemType[];
}

/** Tipos que el NAVEGADOR puede reclamar hoy: si el worker de IA está habilitado, sin los suyos. */
export function browserEffectiveTypes(types: readonly ItemType[], env: Record<string, string | undefined> = process.env): ItemType[] {
  if (!llmWorkerEnabled(env)) return [...types];
  const worker = new Set<string>(llmWorkerTypes(env));
  return types.filter((t) => !worker.has(t));
}
