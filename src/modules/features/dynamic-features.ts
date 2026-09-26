import { ForbiddenException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { readConfiguredRulesVersion } from '../generation-manifests/manifest-rules-config';

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
 * - `DYNAMIC_COHERENCE_LLM` (F78-BE2): SOLO el string exacto `'true'` habilita
 *   la revisión de coherencia con IA (entrada compacta `…/coherence/llm-input`
 *   + UI) para los owners que YA tienen V2. Ausente / otro valor → nadie
 *   (fail closed).
 *
 * Todo se lee de `process.env` en cada llamada (sin caché): cambiar el env +
 * `pm2 restart --update-env` alcanza. Una lista con entradas que no son UUID
 * es un error de configuración que falla ruidoso SOLO en caminos dynamic
 * (nunca en el boot ni en rutas legacy): con el flag OFF ni se parsea.
 */
export const DYNAMIC_FLAG_ENV = 'DYNAMIC_COURSE_STRUCTURE';
export const DYNAMIC_ALLOWED_OWNERS_ENV = 'DYNAMIC_V2_ALLOWED_OWNERS';
export const REAL_VIDEO_OWNERS_ENV = 'DYNAMIC_REAL_VIDEO_OWNERS';
export const COHERENCE_LLM_ENV = 'DYNAMIC_COHERENCE_LLM';

export const DYNAMIC_NOT_ALLOWED_MESSAGE =
  'La estructura dinámica de cursos (V2) no está habilitada para esta cuenta.';
export const REAL_VIDEO_NOT_ALLOWED_MESSAGE =
  'El video real (Videogen, con costo) no está habilitado para esta cuenta. Usá el modo de video "mock" ' +
  'o pedí que habiliten tu cuenta.';
export const COHERENCE_LLM_NOT_ALLOWED_MESSAGE =
  'La revisión de coherencia con IA no está habilitada para esta cuenta.';

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
  /** F78-BE2: revisión de coherencia con IA (DYNAMIC_COHERENCE_LLM === 'true' y V2 permitida). */
  coherenceLlm: boolean;
  /**
   * V2.1 fix round 1 (review G2 I4): rulesVersion configurado
   * (DYNAMIC_MANIFEST_RULES_VERSION). Solo cuando la estructura dinámica está
   * habilitada para el usuario. El editor muestra los toggles V2.1 (Actividad,
   * Examen final, motor) SOLO con 3: con 1/2 el lock produce un Blueprint v1
   * que los ignoraría.
   */
  manifestRulesVersion?: 1 | 2 | 3;
}

export function isDynamicCourseStructureEnabled(env: Env = process.env): boolean {
  return env[DYNAMIC_FLAG_ENV] === 'true';
}

/** Valores de `DYNAMIC_COURSE_STRUCTURE` que NO activan V2 (solo el string exacto 'true' lo hace) pero que
 * parecen un intento fallido de encenderlo — typo o config de otro sistema (M6, fix wave). */
const NEAR_MISS_FLAG_RE = /^(true|1|yes|on)$/i;
let nearMissFlagWarned = false;

/**
 * M6 (review, fix wave): si `DYNAMIC_COURSE_STRUCTURE` está seteado a un
 * valor "casi correcto" (`True`, `TRUE`, `1`, `yes`, `on`…) que NO activa V2
 * (solo el string exacto `'true'` lo hace), loguea un warning UNA sola vez
 * por proceso — para que el silencio no se confunda con "todo bien". Se llama
 * en el arranque de la API (`main.ts`), en el guard dynamic (primer uso de
 * una ruta V2) y en el arranque de los workers dynamic
 * (`holdIdleIfDynamicDisabled`). No hace nada si el flag está ausente o ya en
 * `'true'`.
 */
export function warnIfNearMissDynamicFlag(logInstance: { warn(msg: string): void } = logger, env: Env = process.env): void {
  if (nearMissFlagWarned) return;
  const raw = env[DYNAMIC_FLAG_ENV];
  if (raw === undefined || raw === 'true') return;
  if (!NEAR_MISS_FLAG_RE.test(raw)) return;
  nearMissFlagWarned = true;
  logInstance.warn(
    `${DYNAMIC_FLAG_ENV}="${raw}" no activa V2 (solo el string EXACTO 'true' lo hace) — V2 sigue OFF. ` +
      `Si la intención era encenderlo: ${DYNAMIC_FLAG_ENV}=true.`,
  );
}

/** Solo para tests: resetea el "una sola vez" del warning de near-miss. */
export function _resetNearMissFlagWarningForTests(): void {
  nearMissFlagWarned = false;
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

/** F78-BE2: fail closed — solo `DYNAMIC_COHERENCE_LLM === 'true'` y solo para owners con V2 permitida. */
export function isCoherenceLlmAllowedForOwner(ownerId: string, env: Env = process.env): boolean {
  if (!isDynamicAllowedForOwner(ownerId, env)) return false;
  return env[COHERENCE_LLM_ENV] === 'true';
}

export function resolveDynamicFeatures(ownerId: string, env: Env = process.env): DynamicFeatures {
  if (!isDynamicCourseStructureEnabled(env)) return { dynamicCourseStructure: false, realVideo: false, coherenceLlm: false };
  validateDynamicFeatureConfig(env);
  const dynamicCourseStructure = isDynamicAllowedForOwner(ownerId, env);
  return {
    dynamicCourseStructure,
    realVideo: isRealVideoAllowedForOwner(ownerId, env),
    coherenceLlm: isCoherenceLlmAllowedForOwner(ownerId, env),
    // Config inválida → lanza (fail loud, mismo criterio que el lock y los Manifests).
    ...(dynamicCourseStructure ? { manifestRulesVersion: readConfiguredRulesVersion(env) } : {}),
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

/**
 * Release-fix I4: crear datos dynamic por una ruta LEGACY (POST /courses con
 * `structureVersion: 'dynamic'`). Mismo contrato que las rutas V2: flag OFF →
 * 404 con el mensaje nativo de Nest (`Cannot METHOD url`, la API V2 "no
 * existe"); flag ON → allow-list por owner (403) / lista inválida (500).
 */
export function assertDynamicCreationAllowed(ownerId: string, notFoundMessage = 'Not Found', env: Env = process.env): void {
  if (!isDynamicCourseStructureEnabled(env)) throw new NotFoundException(notFoundMessage);
  assertDynamicOwnerAllowed(ownerId, env);
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

/** F78-BE2: 403 si el owner no tiene la revisión de coherencia con IA (fail closed); 500 si una lista es inválida. */
export function assertCoherenceLlmAllowed(ownerId: string, env: Env = process.env): void {
  let allowed: boolean;
  try {
    allowed = isCoherenceLlmAllowedForOwner(ownerId, env);
  } catch (err) {
    toHttpConfigError(err);
  }
  if (!allowed) throw new ForbiddenException(COHERENCE_LLM_NOT_ALLOWED_MESSAGE);
}
