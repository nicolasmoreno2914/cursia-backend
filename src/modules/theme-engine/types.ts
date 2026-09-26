/**
 * R1 — Theme Engine: public types.
 *
 * `ThemeFamily` + `BrandSeed` -> resolveTheme() -> `ResolvedTheme` (validated
 * by validateTheme()). See H.1 in the v2.1 audit for the pipeline diagram.
 */

export const THEME_ENGINE_VERSION = 1;

export type ThemeFamilyId =
  | 'aula-clara'
  | 'institucional'
  | 'editorial'
  | 'tecnico'
  | 'vibrante'
  | 'oscuro-premium';

export type ThemeMode = 'light' | 'dark';

export type CardVariant = 'flat' | 'outline' | 'tinted';
export type HeroVariant = 'solid' | 'soft';

export interface ThemeColorTokens {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textOnAccent: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  onSuccess: string;
  onWarning: string;
  onDanger: string;
  onInfo: string;
}

export interface ThemeTypographyTokens {
  fontBody: string;
  fontHeading: string;
  sizeBodyPx: number;
  sizeSmallPx: number;
  sizeMetaPx: number;
  sizeH3Px: number;
  sizeH2Px: number;
  sizeH1Px: number;
  lineBody: number;
  lineHeading: number;
  weightBody: number;
  weightHeading: number;
  measureCh: number;
  /** Fluid (clamp()) variants — usable only in ENHANCED rendering, never in CLEAN_SAFE. */
  enhanced: {
    sizeBodyFluid: string;
    sizeH3Fluid: string;
    sizeH2Fluid: string;
    sizeH1Fluid: string;
  };
}

export interface ThemeShapeTokens {
  radiusSm: number;
  radiusMd: number;
  radiusLg: number;
  borderWidth: number;
}

export interface ThemeVariantTokens {
  card: CardVariant;
  callout: CardVariant;
  hero: HeroVariant;
}

/** Per-mode base definition for a ThemeFamily — everything resolveTheme() needs before a seed/mode is applied. */
export interface ThemeFamilyModeBase {
  color: ThemeColorTokens;
  typography: Pick<ThemeTypographyTokens, 'fontBody' | 'fontHeading' | 'weightHeading' | 'lineHeading' | 'measureCh'>;
  shape: ThemeShapeTokens;
  variants: ThemeVariantTokens;
  /** Anchor hues (hex) used to derive module colors when no BrandSeed.moduleColors is given. */
  moduleColors: string[];
}

export interface ThemeFamily {
  id: ThemeFamilyId;
  label: string;
  supportedModes: ThemeMode[];
  defaultMode: ThemeMode;
  modes: Partial<Record<ThemeMode, ThemeFamilyModeBase>>;
}

/** Color intention only (from the user / Brand Kit) — not a theme by itself. */
export interface BrandSeed {
  accent?: string;
  moduleColors?: string[];
}

export interface PresentationProfileInput {
  themeFamily: ThemeFamilyId;
  mode: ThemeMode;
  brandSeed?: BrandSeed;
  themeVersion?: number;
}

export interface ResolvedTheme {
  version: number;
  familyId: ThemeFamilyId;
  mode: ThemeMode;
  color: ThemeColorTokens;
  typography: ThemeTypographyTokens;
  space: number[];
  shape: ThemeShapeTokens;
  variants: ThemeVariantTokens;
  /** Every automatic contrast correction resolveTheme applied, in order, human-readable (Spanish). */
  adjustments: string[];
  /**
   * Resolved anchor hues used by moduleColor() to cycle module colors for
   * this theme (BrandSeed.moduleColors when given, else the family's own
   * anchors for this mode). Not listed among the "named" ResolvedTheme
   * fields in the brief, but moduleColor() is a pure function of
   * (theme, index) alone — it has no other way to recover which anchors a
   * given resolution used. See r1-theme.report.md "rulings".
   */
  moduleColorsBasis: string[];
}

export interface ModuleColor {
  main: string;
  soft: string;
  onMain: string;
  onSoft: string;
  border: string;
}

export interface ThemeValidationError {
  code: string;
  message: string;
}

/** Same shape as the frontend's legacy PALETTES entries (01-state.js) — id + colors only. */
export interface LegacyPalette {
  id: string;
  name?: string;
  desc?: string;
  cat?: string;
  mode?: 'light' | 'dark';
  m1: string;
  m1a?: string;
  m2: string;
  m2a?: string;
  m3: string;
  m3a?: string;
  accent: string;
  dark?: string;
  bg?: string;
  text?: string;
  textMuted?: string;
  cardBg?: string;
  cardHeaderBg?: string;
}
