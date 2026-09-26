/**
 * R9 — mapeo de temas Cursia → Gamma para V2.1.
 *
 * `src/config/gamma-themes.config.ts` (V1) mapea 6 paletas legacy, todas
 * oscuras, a un themeId de Gamma vía env var — mismo patrón acá, pero por
 * `familyId × mode` (6 familias del Theme Engine, con al menos 1 modo claro
 * y 1 oscuro) en vez de por paleta.
 *
 * Igual que V1: los IDs reales de Gamma **nunca se hardcodean** (se crean a
 * mano en Gamma y se cargan por env var), y falla loud si falta config al
 * pedir explícitamente un family/mode sin fallback disponible.
 */
import type { ThemeFamilyId, ThemeMode } from '../../modules/theme-engine';

export type GammaThemeMapKey = `${ThemeFamilyId}:${ThemeMode}`;

const FAMILY_ENV_KEY: Record<ThemeFamilyId, string> = {
  'aula-clara': 'AULA_CLARA',
  institucional: 'INSTITUCIONAL',
  editorial: 'EDITORIAL',
  tecnico: 'TECNICO',
  vibrante: 'VIBRANTE',
  'oscuro-premium': 'OSCURO_PREMIUM',
};

function envKeyFor(familyId: ThemeFamilyId, mode: ThemeMode): string {
  return `GAMMA_THEME_V21_${FAMILY_ENV_KEY[familyId]}_${mode.toUpperCase()}`;
}

/**
 * Construye el mapa completo a partir de `process.env` en el momento en que
 * se llama (no al importar el módulo), para que los tests puedan mutar
 * `process.env` antes de invocarlo sin tener que re-requerir el módulo.
 */
export function buildGammaThemeMap(
  families: ThemeFamilyId[],
  modesByFamily: (familyId: ThemeFamilyId) => ThemeMode[],
): Partial<Record<GammaThemeMapKey, string>> {
  const map: Partial<Record<GammaThemeMapKey, string>> = {};
  for (const familyId of families) {
    for (const mode of modesByFamily(familyId)) {
      const key: GammaThemeMapKey = `${familyId}:${mode}`;
      const v = process.env[envKeyFor(familyId, mode)];
      if (v) map[key] = v;
    }
  }
  return map;
}

/**
 * themeId de Gamma para un family/mode dado.
 *
 * Orden de resolución (fail loud, nunca degrada en silencio con un theme
 * genérico sin decirlo):
 *  1. env var específica de esa familia+modo (`GAMMA_THEME_V21_<FAMILIA>_<MODO>`);
 *  2. fallback por modo (`GAMMA_THEME_V21_LIGHT_DEFAULT` / `_DARK_DEFAULT`) —
 *     así queda garantizado "al menos 1 tema Gamma claro y 1 oscuro" incluso
 *     sin configurar las 6 familias una por una;
 *  3. si ninguna de las dos existe, throw.
 */
export function gammaThemeFor(familyId: ThemeFamilyId, mode: ThemeMode): string {
  const specific = process.env[envKeyFor(familyId, mode)];
  if (specific) return specific;

  const fallbackEnvKey = mode === 'dark' ? 'GAMMA_THEME_V21_DARK_DEFAULT' : 'GAMMA_THEME_V21_LIGHT_DEFAULT';
  const fallback = process.env[fallbackEnvKey];
  if (fallback) return fallback;

  throw new Error(
    `GAMMA_THEME_CONFIG: no hay themeId de Gamma configurado para "${familyId}" (${mode}) — ` +
      `configurá ${envKeyFor(familyId, mode)} o ${fallbackEnvKey}`,
  );
}

export interface ThemeMismatchResult {
  mismatch: boolean;
  warning?: 'theme_mismatch';
  /** Tema de Gamma que corresponde HOY a la familia+modo del curso. */
  expectedGammaThemeId?: string;
  /** Qué cambió respecto de la generación (si el artifact registró familia/modo). */
  changed?: Array<'family' | 'mode' | 'gammaTheme'>;
}

/**
 * ¿La presentación de Gamma ya generada corresponde al tema VIGENTE del curso?
 * Fix round 1 (review G5, I5; §P "theme (familia o modo)"): la comparación es
 * por el tema de Gamma efectivo — `artifact.gammaThemeId !==
 * gammaThemeFor(familia, modo vigentes)` —, así un cambio de familia O de modo
 * que cambia el tema de Gamma produce el aviso. `changed` detalla familia/modo
 * cuando el artifact los registró (`themeModeAtGeneration` es aditivo).
 *
 * Puramente informativo: un cambio de tema **nunca** dispara regeneración de
 * Gamma (presentation queda en REUSE con el aviso `theme_mismatch`; solo se
 * regenera si el usuario lo pide, por costo). Sin efectos secundarios.
 */
export function themeMismatch(
  artifact: { gammaThemeId: string; themeFamilyAtGeneration?: ThemeFamilyId; themeModeAtGeneration?: ThemeMode },
  current: { familyId: ThemeFamilyId; mode: ThemeMode },
): ThemeMismatchResult {
  const expectedGammaThemeId = gammaThemeFor(current.familyId, current.mode);
  const changed: Array<'family' | 'mode' | 'gammaTheme'> = [];
  if (artifact.themeFamilyAtGeneration && artifact.themeFamilyAtGeneration !== current.familyId) changed.push('family');
  if (artifact.themeModeAtGeneration && artifact.themeModeAtGeneration !== current.mode) changed.push('mode');
  if (artifact.gammaThemeId !== expectedGammaThemeId) changed.push('gammaTheme');
  if (!changed.includes('gammaTheme')) return { mismatch: false, expectedGammaThemeId, changed };
  return { mismatch: true, warning: 'theme_mismatch', expectedGammaThemeId, changed };
}
