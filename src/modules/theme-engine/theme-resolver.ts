/**
 * R1 — Theme Engine: resolveTheme / validateTheme / moduleColor / themeSha256.
 *
 * Pure, deterministic. No DB, no clock, no randomness — resolveTheme(input)
 * always produces the same ResolvedTheme for the same input, and
 * `moduleColor(theme, i)` is a pure function of the theme it was resolved
 * into. Every automatic contrast correction is recorded in `adjustments` so
 * a caller can see when a BrandSeed forced Cursia to deviate from what the
 * user picked (fail LOUD, never silently — see CLAUDE.md "Trampas
 * conocidas").
 */
import { sha256Canonical } from '../coherence/canonical-json';
import {
  clamp01,
  contrastRatio,
  correctForegroundForBackgrounds,
  hexToHsl,
  hslToHex,
  isValidHex,
  normalizeHex,
  resolveReadableOn,
} from './color-math';
import { SPACE_SCALE, THEME_FAMILIES } from './families';
import {
  BrandSeed,
  ModuleColor,
  PresentationProfileInput,
  ResolvedTheme,
  ThemeColorTokens,
  ThemeMode,
  ThemeValidationError,
  THEME_ENGINE_VERSION,
} from './types';

const GOLDEN_ANGLE_DEG = 137.50776;
const CONTRAST_BODY = 4.5;
const CONTRAST_BORDER = 3;

function deriveAccentStrong(accent: string, mode: ThemeMode): string {
  const { h, s, l } = hexToHsl(accent);
  const delta = mode === 'light' ? -0.12 : 0.15;
  return hslToHex(h, s, clamp01(l + delta));
}

function deriveAccentSoft(accent: string, mode: ThemeMode): string {
  const { h, s } = hexToHsl(accent);
  return mode === 'light' ? hslToHex(h, Math.min(s, 0.55), 0.93) : hslToHex(h, Math.min(s, 0.45), 0.18);
}

/**
 * Resolves a single `on*`/`textOnAccent`-style readable color that must fit
 * BOTH `accent` and an already-fixed `accentStrong`. accentStrong is never
 * touched here (it was already corrected against `bg` beforehand); if
 * `accent` doesn't support the same readable color as accentStrong, `accent`
 * itself is nudged toward it.
 */
function resolveTextOnAccent(
  accent: string,
  accentStrongFixed: string,
  min: number,
): { accent: string; on: string; changed: boolean } {
  const strongWhiteOk = contrastRatio('#FFFFFF', accentStrongFixed) >= min;
  const strongBlackOk = contrastRatio('#000000', accentStrongFixed) >= min;
  const preferred = strongWhiteOk ? '#FFFFFF' : strongBlackOk ? '#000000' : null;
  if (!preferred) {
    throw new Error(`THEME_INVALID: accentStrong "${accentStrongFixed}" no admite ningún texto legible`);
  }
  if (contrastRatio(preferred, accent) >= min) {
    return { accent, on: preferred, changed: false };
  }
  const { h, s, l } = hexToHsl(accent);
  const darken = preferred === '#FFFFFF';
  for (let i = 1; i <= 50; i++) {
    const ll = clamp01(l + (darken ? -1 : 1) * 0.02 * i);
    const candidate = hslToHex(h, s, ll);
    if (contrastRatio(preferred, candidate) >= min) {
      return { accent: candidate, on: preferred, changed: true };
    }
  }
  throw new Error(`THEME_INVALID: no se pudo ajustar "accent" (${accent}) para un texto legible`);
}

const STATUS_KEYS = ['success', 'warning', 'danger', 'info'] as const;
const STATUS_ON_KEY: Record<(typeof STATUS_KEYS)[number], keyof ThemeColorTokens> = {
  success: 'onSuccess',
  warning: 'onWarning',
  danger: 'onDanger',
  info: 'onInfo',
};

function deriveModuleColorsBasis(
  familyModuleColors: string[],
  brandSeed: BrandSeed | undefined,
): string[] {
  const seedColors = (brandSeed?.moduleColors ?? []).filter((c) => typeof c === 'string' && c.length > 0);
  const basis = seedColors.length > 0 ? seedColors : familyModuleColors;
  return basis.map(normalizeHex);
}

export function resolveTheme(input: PresentationProfileInput): ResolvedTheme {
  const family = THEME_FAMILIES[input.themeFamily];
  if (!family) {
    throw new Error(`THEME_INVALID: familia de tema desconocida "${input.themeFamily}"`);
  }
  if (!family.supportedModes.includes(input.mode)) {
    throw new Error(
      `THEME_INVALID: la familia "${input.themeFamily}" no soporta el modo "${input.mode}" (soporta: ${family.supportedModes.join(', ')})`,
    );
  }
  const baseMode = family.modes[input.mode];
  if (!baseMode) {
    throw new Error(`THEME_INVALID: falta la definición base de "${input.themeFamily}/${input.mode}"`);
  }

  if (input.brandSeed?.accent) normalizeHex(input.brandSeed.accent); // throws THEME_INVALID early on malformed seed
  for (const c of input.brandSeed?.moduleColors ?? []) normalizeHex(c);

  const adjustments: string[] = [];
  const color: ThemeColorTokens = { ...baseMode.color };

  // ── accent / accentStrong / textOnAccent ──────────────────────────────
  if (input.brandSeed?.accent) {
    color.accent = normalizeHex(input.brandSeed.accent);
  }
  const accentStrongInitial = deriveAccentStrong(color.accent, input.mode);
  const accentStrongFixed = correctForegroundForBackgrounds(accentStrongInitial, [color.bg], CONTRAST_BODY);
  color.accentStrong = accentStrongFixed.color;
  if (accentStrongFixed.changed) {
    adjustments.push(
      `accentStrong corregido para contraste ≥ ${CONTRAST_BODY} contra bg (${accentStrongInitial} → ${accentStrongFixed.color})`,
    );
  }

  color.accentSoft = deriveAccentSoft(color.accent, input.mode);

  const onAccent = resolveTextOnAccent(color.accent, color.accentStrong, CONTRAST_BODY);
  if (onAccent.changed) {
    adjustments.push(
      `accent corregido para que textOnAccent sea legible contra accent y accentStrong (${color.accent} → ${onAccent.accent})`,
    );
  }
  color.accent = onAccent.accent;
  color.textOnAccent = onAccent.on;

  // ── body text vs surfaces ──────────────────────────────────────────────
  const textPrimaryFixed = correctForegroundForBackgrounds(
    color.textPrimary,
    [color.bg, color.surface, color.surfaceAlt],
    CONTRAST_BODY,
  );
  if (textPrimaryFixed.changed) {
    adjustments.push(`textPrimary corregido para contraste ≥ ${CONTRAST_BODY} contra bg/surface/surfaceAlt`);
  }
  color.textPrimary = textPrimaryFixed.color;

  const textSecondaryFixed = correctForegroundForBackgrounds(
    color.textSecondary,
    [color.bg, color.surface],
    CONTRAST_BODY,
  );
  if (textSecondaryFixed.changed) {
    adjustments.push(`textSecondary corregido para contraste ≥ ${CONTRAST_BODY} contra bg/surface`);
  }
  color.textSecondary = textSecondaryFixed.color;

  // ── borderStrong ────────────────────────────────────────────────────────
  const borderStrongFixed = correctForegroundForBackgrounds(color.borderStrong, [color.bg], CONTRAST_BORDER);
  if (borderStrongFixed.changed) {
    adjustments.push(`borderStrong corregido para contraste ≥ ${CONTRAST_BORDER} contra bg`);
  }
  color.borderStrong = borderStrongFixed.color;

  // ── status colors ───────────────────────────────────────────────────────
  for (const key of STATUS_KEYS) {
    const onKey = STATUS_ON_KEY[key];
    const resolved = resolveReadableOn(color[key], CONTRAST_BODY);
    if (resolved.changed) {
      adjustments.push(`${key} corregido para que ${onKey} sea legible (${color[key]} → ${resolved.bg})`);
    }
    color[key] = resolved.bg;
    color[onKey] = resolved.on;
  }

  const moduleColorsBasis = deriveModuleColorsBasis(baseMode.moduleColors, input.brandSeed);

  const theme: ResolvedTheme = {
    version: input.themeVersion ?? THEME_ENGINE_VERSION,
    familyId: input.themeFamily,
    mode: input.mode,
    color,
    typography: {
      fontBody: baseMode.typography.fontBody,
      fontHeading: baseMode.typography.fontHeading,
      sizeBodyPx: 18,
      sizeSmallPx: 16,
      sizeMetaPx: 14,
      sizeH3Px: 22,
      sizeH2Px: 28,
      sizeH1Px: 36,
      lineBody: 1.65,
      lineHeading: baseMode.typography.lineHeading,
      weightBody: 400,
      weightHeading: baseMode.typography.weightHeading,
      measureCh: baseMode.typography.measureCh,
      enhanced: {
        sizeBodyFluid: 'clamp(1.0625rem, 1rem + 0.35vw, 1.1875rem)',
        sizeH3Fluid: 'clamp(1.125rem, 1.05rem + 0.35vw, 1.375rem)',
        sizeH2Fluid: 'clamp(1.375rem, 1.2rem + 0.8vw, 1.75rem)',
        sizeH1Fluid: 'clamp(1.75rem, 1.4rem + 1.6vw, 2.25rem)',
      },
    },
    space: [...SPACE_SCALE],
    shape: { ...baseMode.shape },
    variants: { ...baseMode.variants },
    adjustments,
    moduleColorsBasis,
  };

  const errors = validateTheme(theme);
  if (errors.length > 0) {
    throw new Error(
      `THEME_INVALID: el tema resuelto no pasa validateTheme (${errors.length} error(es)): ${errors
        .map((e) => `[${e.code}] ${e.message}`)
        .join('; ')}`,
    );
  }
  return theme;
}

/**
 * Deterministic module color for any index >= 0. Cycles through the
 * theme's resolved anchor hues (BrandSeed.moduleColors or the family's own
 * anchors), rotating by the golden angle once the anchors are exhausted so
 * neighbouring hues never collide even for very large N. Self-corrects
 * main/soft lightness (same algorithm as resolveTheme's status colors) so
 * onMain/onSoft are always ≥ 4.5:1 — this needs no external `adjustments`
 * bookkeeping because it is recomputed identically on every call.
 */
export function moduleColor(theme: ResolvedTheme, moduleIndex0: number): ModuleColor {
  if (!Number.isInteger(moduleIndex0) || moduleIndex0 < 0) {
    throw new Error(`THEME_INVALID: moduleIndex0 debe ser un entero ≥ 0 (recibido ${moduleIndex0})`);
  }
  const basis = theme.moduleColorsBasis.length > 0 ? theme.moduleColorsBasis : [theme.color.accent];
  // Hue comes from a single continuous golden-angle sequence anchored on
  // basis[0] — NOT from each anchor's own hue. Two legacy BrandSeed anchors
  // can be near-neutral and land within a fraction of a degree of each
  // other in hue (e.g. the "slate" palette's m1 #1E293B / m2 #374151 are
  // 0.3° apart), which collapsed adjacent module colors to the same hex
  // when hue was read straight off each anchor. The golden angle (137.5°)
  // is equidistributed, so rotating a single starting hue by index
  // guarantees every one of indices 0..N-1 stays well separated regardless
  // of how degenerate the seed's raw anchors are. The anchors still flavor
  // saturation (cycled per index), so a seed's chroma is not thrown away.
  const hue0 = hexToHsl(basis[0]).h;
  const hue = (hue0 + GOLDEN_ANGLE_DEG * moduleIndex0) % 360;
  const anchorIdx = moduleIndex0 % basis.length;
  const sat = Math.max(hexToHsl(basis[anchorIdx]).s, 0.45);
  const isDark = theme.mode === 'dark';

  const mainBase = hslToHex(hue, sat, isDark ? 0.58 : 0.4);
  const softBase = hslToHex(hue, Math.min(sat, isDark ? 0.35 : 0.3), isDark ? 0.22 : 0.92);
  const border = hslToHex(hue, Math.min(sat, 0.5), isDark ? 0.42 : 0.55);

  const mainResolved = resolveReadableOn(mainBase, CONTRAST_BODY);
  const softResolved = resolveReadableOn(softBase, CONTRAST_BODY);

  return {
    main: mainResolved.bg,
    onMain: mainResolved.on,
    soft: softResolved.bg,
    onSoft: softResolved.on,
    border,
  };
}

export function validateTheme(t: ResolvedTheme, opts?: { moduleCount?: number }): ThemeValidationError[] {
  const errors: ThemeValidationError[] = [];
  const moduleCount = opts?.moduleCount ?? 12;

  function checkHex(value: unknown, path: string) {
    if (!isValidHex(value)) {
      errors.push({ code: 'INVALID_HEX', message: `${path}: "${value}" no es un hex uppercase de 6 dígitos` });
    }
  }
  function checkContrast(fgPath: string, fg: string, bgPath: string, bg: string, min: number) {
    if (!isValidHex(fg) || !isValidHex(bg)) return; // ya reportado por checkHex
    const ratio = contrastRatio(fg, bg);
    if (ratio < min) {
      errors.push({
        code: 'CONTRAST_TOO_LOW',
        message: `${fgPath} (${fg}) vs ${bgPath} (${bg}): ${ratio.toFixed(2)} < ${min}`,
      });
    }
  }

  for (const [k, v] of Object.entries(t.color)) checkHex(v, `color.${k}`);
  for (const [i, v] of t.moduleColorsBasis.entries()) checkHex(v, `moduleColorsBasis[${i}]`);

  const c = t.color;
  checkContrast('textPrimary', c.textPrimary, 'bg', c.bg, CONTRAST_BODY);
  checkContrast('textPrimary', c.textPrimary, 'surface', c.surface, CONTRAST_BODY);
  checkContrast('textPrimary', c.textPrimary, 'surfaceAlt', c.surfaceAlt, CONTRAST_BODY);
  checkContrast('textSecondary', c.textSecondary, 'bg', c.bg, CONTRAST_BODY);
  checkContrast('textSecondary', c.textSecondary, 'surface', c.surface, CONTRAST_BODY);
  checkContrast('textOnAccent', c.textOnAccent, 'accent', c.accent, CONTRAST_BODY);
  checkContrast('textOnAccent', c.textOnAccent, 'accentStrong', c.accentStrong, CONTRAST_BODY);
  for (const key of STATUS_KEYS) {
    const onKey = STATUS_ON_KEY[key];
    checkContrast(onKey, c[onKey], key, c[key], CONTRAST_BODY);
  }
  checkContrast('accentStrong', c.accentStrong, 'bg', c.bg, CONTRAST_BODY);
  checkContrast('borderStrong', c.borderStrong, 'bg', c.bg, CONTRAST_BORDER);

  for (let i = 0; i < moduleCount; i++) {
    let m: ModuleColor;
    try {
      m = moduleColor(t, i);
    } catch (err) {
      errors.push({ code: 'MODULE_COLOR_FAILED', message: `moduleColor(${i}): ${(err as Error).message}` });
      continue;
    }
    checkHex(m.main, `moduleColor(${i}).main`);
    checkHex(m.soft, `moduleColor(${i}).soft`);
    checkHex(m.onMain, `moduleColor(${i}).onMain`);
    checkHex(m.onSoft, `moduleColor(${i}).onSoft`);
    checkHex(m.border, `moduleColor(${i}).border`);
    checkContrast(`moduleColor(${i}).onMain`, m.onMain, `moduleColor(${i}).main`, m.main, CONTRAST_BODY);
    checkContrast(`moduleColor(${i}).onSoft`, m.onSoft, `moduleColor(${i}).soft`, m.soft, CONTRAST_BODY);
  }

  if (t.typography.sizeBodyPx < 16) {
    errors.push({ code: 'FONT_TOO_SMALL', message: `sizeBodyPx ${t.typography.sizeBodyPx} < 16` });
  }
  if (t.typography.sizeSmallPx < 16) {
    errors.push({ code: 'FONT_TOO_SMALL', message: `sizeSmallPx ${t.typography.sizeSmallPx} < 16` });
  }

  return errors;
}

export function themeSha256(t: ResolvedTheme): string {
  return sha256Canonical(t);
}

export function defaultPresentationProfile(): PresentationProfileInput {
  return { themeFamily: 'aula-clara', mode: 'light' };
}
