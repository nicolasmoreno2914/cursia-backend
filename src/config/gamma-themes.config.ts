/**
 * Mapa paletteId (Cursia) → themeId (Gamma).
 * Los 6 themes se crean a mano en Gamma (Biblioteca → Temas), uno por paleta,
 * y sus IDs reales se cargan acá vía env vars — nunca hardcodeados.
 */

const PALETTE_IDS = ['navy-teal', 'ocean', 'berry', 'slate', 'indigo', 'medianoche'] as const;

export type CursiaPaletteId = (typeof PALETTE_IDS)[number];

export const GAMMA_THEME_IDS: Record<CursiaPaletteId, string> = {
  'navy-teal': process.env.GAMMA_THEME_NAVY_TEAL ?? '',
  ocean: process.env.GAMMA_THEME_OCEAN ?? '',
  berry: process.env.GAMMA_THEME_BERRY ?? '',
  slate: process.env.GAMMA_THEME_SLATE ?? '',
  indigo: process.env.GAMMA_THEME_INDIGO ?? '',
  medianoche: process.env.GAMMA_THEME_MEDIANOCHE ?? '',
};

/** Falla loud al arrancar si falta alguno — no degradar en silencio con un theme genérico. */
export function assertGammaThemesConfigured(): void {
  const missing = PALETTE_IDS.filter((id) => !GAMMA_THEME_IDS[id]);
  if (missing.length > 0) {
    throw new Error(
      `Faltan env vars de themeId de Gamma para: ${missing.join(', ')} — ` +
        `configurá GAMMA_THEME_${missing.map((id) => id.toUpperCase().replace(/-/g, '_')).join('/GAMMA_THEME_')}`,
    );
  }
}

export function resolveGammaThemeId(paletteId: string | null | undefined): string {
  const key = (paletteId ?? 'navy-teal') as CursiaPaletteId;
  const themeId = GAMMA_THEME_IDS[key] ?? GAMMA_THEME_IDS['navy-teal'];
  if (!themeId) {
    throw new Error(`No hay themeId de Gamma configurado para la paleta "${paletteId}"`);
  }
  return themeId;
}
