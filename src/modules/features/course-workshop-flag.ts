/**
 * r107 · Flag del «Taller de cursos» (diseño §2.9: apagado por defecto; en staging encendido solo para el dueño hasta B8).
 *
 * - `COURSE_WORKSHOP`: SOLO el string exacto `'true'` lo enciende. Ausente / otro valor → nadie (404 en toda ruta).
 * - `COURSE_WORKSHOP_ALLOWED_OWNERS`: UUIDs separados por coma. FAIL CLOSED: flag encendido + lista vacía → NADIE.
 * - `COURSE_WORKSHOP_ALL_OWNERS`: SOLO `'true'` lo abre a todo usuario registrado (habilitación pública explícita, B8+).
 * Ser SuperAdmin NO lo enciende solo (la lista manda); en staging el dueño va en la lista.
 * Se lee de `process.env` en cada llamada (sin caché), igual que los flags de V2.
 */
import { parseOwnerList } from './dynamic-features';

export const COURSE_WORKSHOP_ENV = 'COURSE_WORKSHOP';
export const COURSE_WORKSHOP_ALLOWED_OWNERS_ENV = 'COURSE_WORKSHOP_ALLOWED_OWNERS';
export const COURSE_WORKSHOP_ALL_OWNERS_ENV = 'COURSE_WORKSHOP_ALL_OWNERS';

type Env = Record<string, string | undefined>;

export function isCourseWorkshopEnabled(env: Env = process.env): boolean {
  return env[COURSE_WORKSHOP_ENV] === 'true';
}

/** ¿Este usuario ve el Taller? Una lista con entradas que no son UUID lanza DynamicFeatureConfigError (500 ruidoso). */
export function isCourseWorkshopAllowedForOwner(ownerId: string, env: Env = process.env): boolean {
  if (!isCourseWorkshopEnabled(env)) return false;
  const allowed = parseOwnerList(COURSE_WORKSHOP_ALLOWED_OWNERS_ENV, env);
  if (env[COURSE_WORKSHOP_ALL_OWNERS_ENV] === 'true') return true;
  return allowed.includes(String(ownerId ?? '').toLowerCase());
}
