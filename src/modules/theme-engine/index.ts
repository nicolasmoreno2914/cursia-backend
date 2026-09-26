/**
 * R1 — Theme Engine public barrel. See:
 *  - types.ts            — exported types (ThemeFamilyId, ResolvedTheme, BrandSeed, …)
 *  - families.ts          — THEME_FAMILIES catalog
 *  - color-math.ts        — contrastRatio / relativeLuminance / hex-hsl helpers
 *  - theme-resolver.ts    — resolveTheme / validateTheme / moduleColor / themeSha256
 *  - brand-seed.ts         — brandSeedFromLegacyPalette / legacyPaletteThemeFallback
 *  - legacy-palettes-data.ts — LEGACY_PALETTES (28 entries, mirrors the frontend)
 */
export * from './types';
export { THEME_FAMILIES, SPACE_SCALE } from './families';
export { contrastRatio, relativeLuminance, normalizeHex, isValidHex, isPureBlackOrWhite, ON_LIGHT, ON_DARK } from './color-math';
export { resolveTheme, validateTheme, moduleColor, moduleColorAdjustments, themeSha256, defaultPresentationProfile } from './theme-resolver';
export { brandSeedFromLegacyPalette, legacyPaletteThemeFallback } from './brand-seed';
export { LEGACY_PALETTES } from './legacy-palettes-data';
export { ThemeEngineModule } from './theme-engine.module';
