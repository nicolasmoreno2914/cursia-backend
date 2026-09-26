/**
 * V2.1 — fix round 1 (review G2 I1): modo de PROVEEDOR (Gamma / TTS) de un run
 * rulesVersion 3, congelado en `production_jobs.input_payload.providerModes`
 * al crear el run. Nunca se deriva de `videoMode`.
 *
 *  - Default (y único valor de producción): `real`. Mientras R9/R10 no cablean
 *    los proveedores, un item `real` falla FUERTE con PROVIDER_NOT_WIRED_V21 al
 *    ejecutarse (nunca una salida falsa marcada `completed`).
 *  - `mock` solo si se pide EXPLÍCITAMENTE en el body (`providerModes`) Y el
 *    entorno lo permite (`DYNAMIC_ALLOW_PROVIDER_MOCK=true`, escape de
 *    no-producción, como DYNAMIC_ALLOW_VIDEOGEN_DIRECT). El worker lo vuelve a
 *    exigir al ejecutar.
 *  - Runs v1/v2: sin items de proveedor ⇒ no se congela nada (input_payload
 *    byte-idéntico al de antes).
 *  - Un run v3 sin `providerModes` congelado (creado antes de este fix) ⇒ el
 *    worker falla con PROVIDER_MODE_UNSET (nunca asume un modo).
 *
 * Funciones puras (el env se pasa como parámetro para poder probarlas).
 */

export type ProviderMode = 'real' | 'mock';
export const PROVIDER_MODE_VALUES: readonly ProviderMode[] = ['real', 'mock'];
export type ProviderKind = 'presentation' | 'audio';
export const PROVIDER_KINDS: readonly ProviderKind[] = ['presentation', 'audio'];
export interface ProviderModes {
  presentation: ProviderMode;
  audio: ProviderMode;
}

export const ALLOW_PROVIDER_MOCK_ENV = 'DYNAMIC_ALLOW_PROVIDER_MOCK';
export const PROVIDER_MOCK_NOT_ALLOWED = 'provider_mock_not_allowed';
export const PROVIDER_MODE_INVALID = 'provider_mode_invalid';
export const PROVIDER_MODE_UNSET = 'PROVIDER_MODE_UNSET';
export const PROVIDER_MODES_CONFLICT = 'provider_modes_conflict';

export class ProviderModeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ProviderModeError';
  }
}

/** Proveedor de un tipo de item v3 (`null` = el item no paga Gamma/TTS). */
export function providerKindOfItemType(type: string): ProviderKind | null {
  if (type === 'presentation') return 'presentation';
  if (type === 'audio_welcome' || type === 'audiobook_chapter') return 'audio';
  return null;
}

/** Proveedor de un tipo de ARTIFACT (para la guarda de empaque). */
export function providerKindOfArtifactType(type: string): ProviderKind | null {
  if (type === 'dynamic_presentation') return 'presentation';
  if (type === 'dynamic_audio_mp3') return 'audio';
  return null;
}

export function isProviderMockAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[ALLOW_PROVIDER_MOCK_ENV] === 'true';
}

/**
 * Modos a congelar al CREAR un run. v1/v2 → `undefined` (no se congela nada).
 * v3 → `{presentation, audio}`: lo omitido es `real`; `mock` exige el escape
 * de entorno (403 `provider_mock_not_allowed`); cualquier otro valor → 400.
 */
export function resolveProviderModes(
  rulesVersion: number,
  requested: unknown,
  env: Record<string, string | undefined> = process.env,
): ProviderModes | undefined {
  if (rulesVersion !== 3) {
    if (requested !== undefined && requested !== null) {
      throw new ProviderModeError(PROVIDER_MODE_INVALID, `providerModes solo aplica a Manifests rulesVersion 3 (este es ${rulesVersion})`);
    }
    return undefined;
  }
  if (requested !== undefined && requested !== null && (typeof requested !== 'object' || Array.isArray(requested))) {
    throw new ProviderModeError(PROVIDER_MODE_INVALID, 'providerModes debe ser un objeto {presentation?, audio?}');
  }
  const r = (requested ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(k)) {
      throw new ProviderModeError(PROVIDER_MODE_INVALID, `providerModes.${k} no existe (permitidos: ${PROVIDER_KINDS.join(', ')})`);
    }
  }
  const out = {} as ProviderModes;
  for (const k of PROVIDER_KINDS) {
    const v = r[k];
    if (v === undefined || v === null) out[k] = 'real';
    else if (v === 'real' || v === 'mock') out[k] = v;
    else throw new ProviderModeError(PROVIDER_MODE_INVALID, `providerModes.${k}=${JSON.stringify(v)} (permitidos: real, mock)`);
  }
  if ((out.presentation === 'mock' || out.audio === 'mock') && !isProviderMockAllowed(env)) {
    throw new ProviderModeError(
      PROVIDER_MOCK_NOT_ALLOWED,
      `providerModes mock requiere ${ALLOW_PROVIDER_MOCK_ENV}=true (escape de no-producción); el default y único modo de producción es real`,
    );
  }
  return out;
}

/** Modos congelados de un run (`null` si no hay o si están corruptos: nunca se asume uno). */
export function frozenProviderModesOf(inputPayload: any): ProviderModes | null {
  const pm = inputPayload?.providerModes;
  if (!pm || typeof pm !== 'object') return null;
  if (!PROVIDER_MODE_VALUES.includes(pm.presentation) || !PROVIDER_MODE_VALUES.includes(pm.audio)) return null;
  return { presentation: pm.presentation, audio: pm.audio };
}

export function sameProviderModes(a: ProviderModes | null | undefined, b: ProviderModes | null | undefined): boolean {
  return (a?.presentation ?? null) === (b?.presentation ?? null) && (a?.audio ?? null) === (b?.audio ?? null);
}

/**
 * Review G2 M1: el worker de proveedor (`dynamic-provider-worker`) todavía no
 * está en PM2. Sin él, los items presentation/audio_* de un run v3 quedarían
 * `pending` para siempre (estancamiento silencioso). Hasta que R9/R10 lo
 * desplieguen, crear trabajo de proveedor exige declarar que el worker corre
 * (`DYNAMIC_PROVIDER_WORKER_ENABLED=true`); si no → 501 al iniciar el run.
 */
export const PROVIDER_WORKER_ENABLED_ENV = 'DYNAMIC_PROVIDER_WORKER_ENABLED';
export const PROVIDER_WORKER_NOT_DEPLOYED = 'PROVIDER_WORKER_NOT_DEPLOYED';

export function isProviderWorkerDeployed(env: Record<string, string | undefined> = process.env): boolean {
  return env[PROVIDER_WORKER_ENABLED_ENV] === 'true';
}

export function providerWorkerNotDeployedMessage(): string {
  return (
    `${PROVIDER_WORKER_NOT_DEPLOYED}: este run tiene items de Gamma/TTS (presentation, audio_welcome, audiobook_chapter) ` +
    `y el worker de proveedor no está desplegado (${PROVIDER_WORKER_ENABLED_ENV}≠true). Sin él quedarían pendientes para siempre.`
  );
}
