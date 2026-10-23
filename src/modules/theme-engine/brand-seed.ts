/**
 * R1 — Theme Engine: BrandSeed helpers — migration path from the frontend's
 * legacy PALETTES (color intention only, never a full theme by itself).
 */
import { normalizeHex } from './color-math';
import { LEGACY_PALETTES } from './legacy-palettes-data';
import { BrandSeed, LegacyPalette, PresentationProfileInput } from './types';

/** Maps a legacy frontend palette entry to a BrandSeed (accent + module hues). */
export function brandSeedFromLegacyPalette(p: LegacyPalette): BrandSeed {
  const seed: BrandSeed = {};
  if (p.accent) {
    seed.accent = normalizeHex(p.accent);
  }
  const moduleColors = [p.m1, p.m2, p.m3].filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (moduleColors.length > 0) {
    seed.moduleColors = moduleColors.map(normalizeHex);
  }
  return seed;
}

/**
 * Fallback presentation profile for a course generated before the Theme
 * Engine existed (audit §S) — identified only by its legacy palette id.
 * Always resolves to `oscuro-premium` / `dark` (the closest family to how
 * every pre-R1 palette actually rendered: fixed dark background, module
 * hues from the palette).
 */
export function legacyPaletteThemeFallback(paletteId: string): PresentationProfileInput {
  const found = LEGACY_PALETTES.find((p) => p.id === paletteId);
  if (!found) {
    throw new Error(`THEME_INVALID: paleta legacy desconocida "${paletteId}"`);
  }
  return {
    themeFamily: 'oscuro-premium',
    mode: 'dark',
    brandSeed: brandSeedFromLegacyPalette(found),
  };
}

/**
 * F1 (review I4): perfil de presentación POR DEFECTO de un curso v3 derivado
 * de la paleta que eligió el usuario (audit §H.4: la paleta migra como
 * BrandSeed combinable con cualquier familia).
 * - Paletas claras (`cat: 'claro'` o `mode: 'light'`) → `aula-clara`/light.
 * - Todas las demás (`oscuro`, `profesional`, `colorido`, `calido`: en V1 se
 *   veían sobre fondo oscuro) → `oscuro-premium`/dark.
 * - `brandSeed` = `brandSeedFromLegacyPalette(palette)`.
 * Pura. Espejo exacto en el frontend (`47-course-profiles-panel.js`,
 * `cprofPresentationFromPalette`).
 */
export function presentationProfileFromPalette(p: LegacyPalette): Required<Pick<PresentationProfileInput, 'themeFamily' | 'mode' | 'themeVersion'>> & { brandSeed: BrandSeed } {
  if (!p || typeof p !== 'object') throw new Error('THEME_INVALID: paleta inválida');
  const light = p.cat === 'claro' || p.mode === 'light';
  return {
    themeFamily: light ? 'aula-clara' : 'oscuro-premium',
    mode: light ? 'light' : 'dark',
    brandSeed: brandSeedFromLegacyPalette(p),
    themeVersion: 1,
  };
}

/** F1 (I4): igual que `presentationProfileFromPalette`, por id de paleta. Id desconocido → THEME_INVALID. */
export function presentationProfileFromPaletteId(paletteId: string): ReturnType<typeof presentationProfileFromPalette> {
  const found = LEGACY_PALETTES.find((p) => p.id === paletteId);
  if (!found) {
    throw new Error(`THEME_INVALID: paleta legacy desconocida "${paletteId}"`);
  }
  return presentationProfileFromPalette(found);
}
