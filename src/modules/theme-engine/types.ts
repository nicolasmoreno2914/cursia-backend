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
  /**
   * R14-A — escala editorial (Design Language V1 §1). Los *Px son la base CLEAN_SAFE;
   * `scale` son los clamp() de ENHANCED (mismo orden de roles).
   */
  sizeDisplayPx: number;
  sizeTitlePx: number;
  sizeItemPx: number;
  sizeLeadPx: number;
  sizeStatementPx: number;
  sizeNumeralPx: number;
  scale: {
    display: string;
    title: string;
    item: string;
    lead: string;
    statement: string;
    numeral: string;
  };
}

/** R14-A — cómo se abre un capítulo/curso en cada familia (Design Language V1 §5–6). */
export type HeroTreatment = 'rule' | 'band' | 'plate';
export type Density = 'compact' | 'regular' | 'airy';

/**
 * R14-A — personalidad de la familia: tipografía y composición, no solo color
 * (Design Language V1 §6). Derivada de la familia; no entra en validateTheme de color.
 */
export interface ThemePersonality {
  fontDisplay: string;
  fontMeta: string;
  fontNumeral: string;
  displayWeight: number;
  thesisItalic: boolean;
  heroTreatment: HeroTreatment;
  density: Density;
  /** Filete de 1 px entre componentes de un mismo label (Editorial). */
  ruleBetween: boolean;
  /** Tracking de las líneas meta, en em. */
  metaTracking: number;
  /** El label pinta su fondo como una lámina (familias oscuras); si no, el contenido va abierto sobre la página. */
  plate: boolean;
  /** Filete de acento de 2 px a todo el ancho sobre el kicker de cada componente (membrete, Institucional). */
  /**
   * @deprecated P3 (sistema visual 2.0): el filete de sección sobre el kicker fue reemplazado por el rótulo
   * del rol pedagógico en todo componente; el campo se conserva (datos de familias y temas guardados) y no
   * tiene efecto en el renderer.
   */
  sectionRule: boolean;
  /** Filetes de ítem en borderStrong (retícula de ficha técnica, Técnico). */
  gridRules: boolean;
  /** Kicker en mayúsculas con tracking (default) o en "oración" (Aula clara: más cercano). */
  metaCase: 'upper' | 'sentence';
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
  personality: ThemePersonality;
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

/** P3 — Sistema visual educativo 2.0: rol pedagógico de un bloque (ícono + color + forma). */
export type EduBlockRole = 'concepto' | 'ejemplo' | 'caso' | 'error' | 'proceso' | 'decision' | 'reflexion' | 'visual';
export const EDU_BLOCK_ROLES: readonly EduBlockRole[] = ['concepto', 'ejemplo', 'caso', 'error', 'proceso', 'decision', 'reflexion', 'visual'];
/**
 * ink   = texto del rótulo / ícono / filete (≥ 4.5:1 sobre soft Y sobre el fondo del label)
 * soft  = superficie tintada del bloque (textPrimary ≥ 4.5:1 encima)
 * edge  = borde de 1 px de la superficie (decorativo, sin requisito de contraste)
 * onInk = texto sobre una insignia rellena de ink (≥ 4.5:1)
 */
export interface EduBlockTone {
  ink: string;
  soft: string;
  edge: string;
  onInk: string;
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
  personality: ThemePersonality;
  /** P3 — tonos por rol pedagógico (semánticos: iguales en todas las familias de un mismo modo). */
  blocks: Record<EduBlockRole, EduBlockTone>;
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
  /**
   * P3 (fix I1-R1): de dónde salen las anclas de módulo. 'brand' = BrandSeed.moduleColors (marca del
   * cliente o paleta guardada/legacy): esos colores NUNCA se alteran por pedagogía. 'family' = anclas
   * propias de Cursia (role-safe y perceptualmente lejos de los roles). Los módulos generados más allá
   * de las anclas son de Cursia en ambos casos.
   */
  moduleColorsSource: 'brand' | 'family';
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
