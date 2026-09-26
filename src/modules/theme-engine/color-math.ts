/**
 * R1 — Theme Engine: color math (pure).
 *
 * WCAG 2.2 relative luminance / contrast ratio, plus small HSL <-> hex
 * helpers used to auto-correct any color pair that fails its contrast
 * minimum (see theme-resolver.ts). No DOM, no randomness, no clock — every
 * function here is a pure function of its inputs so `resolveTheme` stays
 * deterministic (byte-identical output for the same input).
 */

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

/** Validates and uppercases a `#RRGGBB` hex color. Throws THEME_INVALID otherwise. */
export function normalizeHex(hex: string): string {
  if (typeof hex !== 'string' || !HEX_RE.test(hex.trim())) {
    throw new Error(`THEME_INVALID: color hex inválido "${hex}" (se espera #RRGGBB)`);
  }
  return `#${hex.trim().slice(1).toUpperCase()}`;
}

export function isValidHex(hex: unknown): hex is string {
  return typeof hex === 'string' && HEX_RE.test(hex);
}

export function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => toByte(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG 2.2 relative luminance (0..1), from an sRGB hex color. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const chan = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  const R = chan(r);
  const G = chan(g);
  const B = chan(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG 2.2 contrast ratio between two hex colors, in [1, 21]. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

export function hexToHsl(hex: string): Hsl {
  const { r, g, b } = hexToRgb(hex);
  const r1 = r / 255;
  const g1 = g / 255;
  const b1 = b / 255;
  const max = Math.max(r1, g1, b1);
  const min = Math.min(r1, g1, b1);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r1:
      h = ((g1 - b1) / d + (g1 < b1 ? 6 : 0)) * 60;
      break;
    case g1:
      h = ((b1 - r1) / d + 2) * 60;
      break;
    default:
      h = ((r1 - g1) / d + 4) * 60;
  }
  return { h, s, l };
}

function hueToRgbChannel(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  if (sat === 0) {
    const v = toByte(light * 255);
    return rgbToHex(v, v, v);
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const hk = hue / 360;
  const r = hueToRgbChannel(p, q, hk + 1 / 3);
  const g = hueToRgbChannel(p, q, hk);
  const b = hueToRgbChannel(p, q, hk - 1 / 3);
  return rgbToHex(r * 255, g * 255, b * 255);
}

/**
 * Chooses a readable `on` color (pure white or pure black) for a background.
 * If neither reaches `min` contrast, walks the background's own hue/sat in
 * both lightness directions (deterministic 0.02 steps) until one side
 * works, returning the (possibly corrected) background alongside the `on`
 * color that now fits it. Always terminates because contrast against white
 * grows monotonically as lightness falls toward 0 (and against black as it
 * rises toward 1).
 */
export function resolveReadableOn(
  bg: string,
  min: number,
): { bg: string; on: string; changed: boolean } {
  if (contrastRatio('#FFFFFF', bg) >= min) return { bg, on: '#FFFFFF', changed: false };
  if (contrastRatio('#000000', bg) >= min) return { bg, on: '#000000', changed: false };
  const { h, s, l } = hexToHsl(bg);
  for (let i = 1; i <= 50; i++) {
    const dl = 0.02 * i;
    const darker = hslToHex(h, s, clamp01(l - dl));
    if (contrastRatio('#FFFFFF', darker) >= min) return { bg: darker, on: '#FFFFFF', changed: true };
    const lighter = hslToHex(h, s, clamp01(l + dl));
    if (contrastRatio('#000000', lighter) >= min) return { bg: lighter, on: '#000000', changed: true };
  }
  throw new Error(`THEME_INVALID: no se pudo generar un color legible a partir de "${bg}"`);
}

/**
 * Adjusts `fg` (moving its own lightness away from the given backgrounds)
 * until it reaches `min` contrast against every one of them. Used for
 * tokens that must stand on their own as a foreground/text color against
 * one or more fixed backgrounds (textPrimary, textSecondary, accentStrong
 * as a link color, borderStrong).
 */
export function correctForegroundForBackgrounds(
  fg: string,
  backgrounds: string[],
  min: number,
): { color: string; changed: boolean } {
  const worst = (c: string) => Math.min(...backgrounds.map((bg) => contrastRatio(c, bg)));
  if (worst(fg) >= min) return { color: fg, changed: false };
  const { h, s, l } = hexToHsl(fg);
  const avgBgLum = backgrounds.reduce((sum, bg) => sum + relativeLuminance(bg), 0) / backgrounds.length;
  const darken = relativeLuminance(fg) <= avgBgLum;
  for (let i = 1; i <= 50; i++) {
    const ll = clamp01(l + (darken ? -1 : 1) * 0.02 * i);
    const candidate = hslToHex(h, s, ll);
    if (worst(candidate) >= min) return { color: candidate, changed: true };
    if (ll <= 0 || ll >= 1) break;
  }
  if (worst('#000000') >= min) return { color: '#000000', changed: true };
  if (worst('#FFFFFF') >= min) return { color: '#FFFFFF', changed: true };
  throw new Error(`THEME_INVALID: no se pudo corregir "${fg}" contra [${backgrounds.join(', ')}]`);
}
