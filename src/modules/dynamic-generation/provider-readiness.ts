/**
 * V2.1 F2 — preflight de proveedores de un run rulesVersion 3 (review final
 * I1/I2). Puro: el entorno se pasa como parámetro; no hay red, DB ni reloj.
 *
 * Antes de cualquier escritura o gasto (startRun / fromRun):
 *  - cada proveedor congelado en `real` (presentation → Gamma, audio → TTS +
 *    el guion LLM del audiolibro, video → Videogen) tiene que estar CABLEADO
 *    en código y CONFIGURADO (clave de API; para Gamma además un themeId para
 *    cada familia/modo del Theme Engine). Si no → 409 `provider_not_ready` con
 *    la lista de lo que falta (solo nombres de variables, nunca valores);
 *  - los videos de un run v3 exigen entrega YouTube: `video_interactions`
 *    necesita el id de YouTube → 409 `v3_requires_youtube_delivery` si la
 *    estrategia congelada sería `videogen_direct` (mock o real).
 *
 * Mock sigue permitido solo con sus condiciones explícitas de siempre
 * (resolveProviderModes / DYNAMIC_ALLOW_PROVIDER_MOCK): acá un modo `mock` no
 * exige nada.
 */
import { THEME_FAMILIES } from '../theme-engine/families';
import type { ThemeFamilyId, ThemeMode } from '../theme-engine/types';
import type { ProviderModes } from './provider-modes';
import type { VideoDeliveryStrategy } from './dynamic-video-delivery';

export const PROVIDER_NOT_READY = 'provider_not_ready';
export const V3_REQUIRES_YOUTUBE_DELIVERY = 'v3_requires_youtube_delivery';

/**
 * Proveedores con camino real cableado en código (F2: Gamma y TTS; Videogen
 * desde 5A). Un proveedor `false` acá hace fallar el preflight aunque tenga
 * clave (nunca se crea un run que no puede terminar).
 */
export const REAL_PROVIDER_WIRED: Readonly<Record<'presentation' | 'audio' | 'video', boolean>> = {
  presentation: true,
  audio: true,
  video: true,
};

/** Variables de entorno que cada proveedor real necesita (clave; nunca se loguea el valor). */
export const GAMMA_API_KEY_ENV = 'GAMMA_API_KEY';
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const VIDEOGEN_API_KEY_ENV = 'VIDEOGEN_API_KEY';

type Env = Record<string, string | undefined>;

function present(env: Env, k: string): boolean {
  return typeof env[k] === 'string' && (env[k] as string).trim() !== '';
}

/** Mismo nombre de variable que R9 `gammaThemeFor` (GAMMA_THEME_V21_<FAMILIA>_<MODO>). */
export function gammaThemeEnvKey(familyId: ThemeFamilyId, mode: ThemeMode): string {
  return `GAMMA_THEME_V21_${familyId.toUpperCase().replace(/-/g, '_')}_${mode.toUpperCase()}`;
}

/**
 * Familias/modos del Theme Engine sin themeId de Gamma resoluble (ni el
 * específico ni el default del modo). Espejo exacto de la resolución de R9
 * `gammaThemeFor`, pero con el entorno como parámetro.
 */
export function missingGammaThemes(env: Env): string[] {
  const missing: string[] = [];
  for (const familyId of Object.keys(THEME_FAMILIES) as ThemeFamilyId[]) {
    for (const mode of THEME_FAMILIES[familyId].supportedModes) {
      const fallback = mode === 'dark' ? 'GAMMA_THEME_V21_DARK_DEFAULT' : 'GAMMA_THEME_V21_LIGHT_DEFAULT';
      if (!present(env, gammaThemeEnvKey(familyId, mode)) && !present(env, fallback)) {
        missing.push(`${gammaThemeEnvKey(familyId, mode)}|${fallback}`);
      }
    }
  }
  return missing;
}

export interface ProviderReadinessInput {
  providerModes: ProviderModes;
  videoMode: 'mock' | 'real';
  /** Cantidad de items `video` del Manifest que el run va a tener. */
  videoCount: number;
}

/** Lo que falta para que cada proveedor REAL del run funcione ([] = listo). */
export function providerReadinessMissing(input: ProviderReadinessInput, env: Env = process.env): string[] {
  const missing: string[] = [];
  if (input.providerModes.presentation === 'real') {
    if (!REAL_PROVIDER_WIRED.presentation) missing.push('presentation:not_wired');
    if (!present(env, GAMMA_API_KEY_ENV)) missing.push(`presentation:${GAMMA_API_KEY_ENV}`);
    for (const t of missingGammaThemes(env)) missing.push(`presentation:${t}`);
  }
  if (input.providerModes.audio === 'real') {
    if (!REAL_PROVIDER_WIRED.audio) missing.push('audio:not_wired');
    if (!present(env, OPENAI_API_KEY_ENV)) missing.push(`audio:${OPENAI_API_KEY_ENV}`);
    // El guion del audiolibro (un capítulo) lo escribe el LLM server-side, medido en el ledger.
    if (!present(env, ANTHROPIC_API_KEY_ENV)) missing.push(`audio:${ANTHROPIC_API_KEY_ENV}`);
  }
  if (input.videoMode === 'real' && input.videoCount > 0) {
    if (!REAL_PROVIDER_WIRED.video) missing.push('video:not_wired');
    if (!present(env, VIDEOGEN_API_KEY_ENV)) missing.push(`video:${VIDEOGEN_API_KEY_ENV}`);
  }
  return missing;
}

export function providerNotReadyMessage(missing: string[]): string {
  return (
    `${PROVIDER_NOT_READY}: este run v3 usa proveedores reales que no están listos en este entorno ` +
    `(${missing.join(', ')}). No se creó nada ni hubo gasto. Configurá lo que falta o usá un run mock ` +
    '(solo donde DYNAMIC_ALLOW_PROVIDER_MOCK=true).'
  );
}

/**
 * I2 (a): un run v3 con videos necesita entrega YouTube (el video interactivo
 * H5P se arma sobre el id de YouTube). `frozenDelivery` = la estrategia que el
 * run congelaría (o la congelada de A en fromRun).
 */
export function v3VideoDeliveryOk(videoCount: number, frozenDelivery: VideoDeliveryStrategy): boolean {
  return videoCount === 0 || frozenDelivery === 'youtube';
}

export function v3RequiresYoutubeMessage(frozenDelivery: VideoDeliveryStrategy): string {
  return (
    `${V3_REQUIRES_YOUTUBE_DELIVERY}: los videos de un curso V2.1 (rulesVersion 3) se publican en YouTube Unlisted ` +
    `para armar el video interactivo; este run quedaría con entrega "${frozenDelivery}" y sus preguntas de video ` +
    'fallarían al final. Configurá DYNAMIC_VIDEO_DELIVERY=youtube. No se creó nada ni hubo gasto.'
  );
}
