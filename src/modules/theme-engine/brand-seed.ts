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
