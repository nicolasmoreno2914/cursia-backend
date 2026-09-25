import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';

/**
 * Flags de entorno del rollout gradual de la estructura dinámica de cursos
 * (V2) — spec §-1 "Rollout gradual", audit-9 G1/G3 y review 5C I1.
 *
 * - `DYNAMIC_COURSE_STRUCTURE`: SOLO el string exacto `'true'` activa V2.
 *   Ausente / cualquier otro valor → OFF (default de producción).
 * - `DYNAMIC_V2_ALLOWED_OWNERS`: UUIDs de owner separados por coma.
 *   Flag OFF → nadie; flag ON + lista vacía/ausente → todos (staging);
 *   flag ON + lista → solo esos owners.
 * - `DYNAMIC_REAL_VIDEO_OWNERS`: UUIDs de owner que pueden iniciar runs con
 *   `videoMode: 'real'` (Videogen pago). FAIL CLOSED: ausente/vacía → nadie.
 *
 * Todo se lee de `process.env` en cada llamada (sin caché): cambiar el env +
 * `pm2 restart --update-env` alcanza. Una lista con entradas que no son UUID
 * es un error de configuración que falla ruidoso SOLO en caminos dynamic
 * (nunca en el boot ni en rutas legacy): con el flag OFF ni se parsea.
 */
export const DYNAMIC_FLAG_ENV = 'DYNAMIC_COURSE_STRUCTURE';
export const DYNAMIC_ALLOWED_OWNERS_ENV = 'DYNAMIC_V2_ALLOWED_OWNERS';
export const REAL_VIDEO_OWNERS_ENV = 'DYNAMIC_REAL_VIDEO_OWNERS';

export const DYNAMIC_NOT_ALLOWED_MESSAGE =
  'La estructura dinámica de cursos (V2) no está habilitada para esta cuenta.';
export const REAL_VIDEO_NOT_ALLOWED_MESSAGE =
  'El video real (Videogen, con costo) no está habilitado para esta cuenta. Usá el modo de video "mock" ' +
  'o pedí que habiliten tu cuenta.';

type Env = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = new Logger('DynamicFeatures');

export class DynamicFeatureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DynamicFeatureConfigError';
  }
}

export interface DynamicFeatures {
  dynamicCourseStructure: boolean;
  realVideo: boolean;
}

export function isDynamicCourseStructureEnabled(env: Env = process.env): boolean {
  return env[DYNAMIC_FLAG_ENV] === 'true';
}

/** Lista de owners (minúsculas). Entradas vacías se ignoran; no-UUID → DynamicFeatureConfigError. */
export function parseOwnerList(envName: string, env: Env = process.env): string[] {
  const raw = env[envName] ?? '';
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = entries.filter((e) => !UUID_RE.test(e));
  if (invalid.length) {
    throw new DynamicFeatureConfigError(
      `Configuración inválida: ${envName} debe ser una lista de UUIDs separados por coma; ` +
        `entradas inválidas: ${invalid.map((e) => JSON.stringify(e)).join(', ')}`,
    );
  }
  return entries.map((e) => e.toLowerCase());
}

/** Valida las listas (solo tiene sentido con el flag ON). Lanza DynamicFeatureConfigError. */
export function validateDynamicFeatureConfig(env: Env = process.env): void {
  parseOwnerList(DYNAMIC_ALLOWED_OWNERS_ENV, env);
  parseOwnerList(REAL_VIDEO_OWNERS_ENV, env);
}

export function isDynamicAllowedForOwner(ownerId: string, env: Env = process.env): boolean {
  if (!isDynamicCourseStructureEnabled(env)) return false;
  const allowed = parseOwnerList(DYNAMIC_ALLOWED_OWNERS_ENV, env);
  if (!allowed.length) return true;
  return allowed.includes(String(ownerId ?? '').toLowerCase());
}

export function isRealVideoAllowedForOwner(ownerId: string, env: Env = process.env): boolean {
  if (!isDynamicAllowedForOwner(ownerId, env)) return false;
  const allowed = parseOwnerList(REAL_VIDEO_OWNERS_ENV, env);
  return allowed.includes(String(ownerId ?? '').toLowerCase());
}

export function resolveDynamicFeatures(ownerId: string, env: Env = process.env): DynamicFeatures {
  if (!isDynamicCourseStructureEnabled(env)) return { dynamicCourseStructure: false, realVideo: false };
  validateDynamicFeatureConfig(env);
  return {
    dynamicCourseStructure: isDynamicAllowedForOwner(ownerId, env),
    realVideo: isRealVideoAllowedForOwner(ownerId, env),
  };
}

/** DynamicFeatureConfigError → 500 ruidoso (logueado); cualquier otro error se relanza. */
export function toHttpConfigError(err: unknown): never {
  if (err instanceof DynamicFeatureConfigError) {
    logger.error(err.message);
    throw new InternalServerErrorException(err.message);
  }
  throw err;
}

/** 403 si el owner no puede usar V2 (flag OFF o fuera de la allow-list); 500 si la lista es inválida. */
export function assertDynamicOwnerAllowed(ownerId: string, env: Env = process.env): void {
  let allowed: boolean;
  try {
    allowed = isDynamicAllowedForOwner(ownerId, env);
  } catch (err) {
    toHttpConfigError(err);
  }
  if (!allowed) throw new ForbiddenException(DYNAMIC_NOT_ALLOWED_MESSAGE);
}

/** 403 si el owner no puede iniciar/reabrir un run con video real (fail closed); 500 si la lista es inválida. */
export function assertRealVideoAllowed(ownerId: string, env: Env = process.env): void {
  let allowed: boolean;
  try {
    allowed = isRealVideoAllowedForOwner(ownerId, env);
  } catch (err) {
    toHttpConfigError(err);
  }
  if (!allowed) throw new ForbiddenException(REAL_VIDEO_NOT_ALLOWED_MESSAGE);
}
