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

/**
 * "Blanco" y "negro" del sistema: tintes casi puros. §G.4 prohíbe #FFFFFF/#000000 puros
 * en la salida; todo `on*`/texto legible usa estos en su lugar.
 */
export const ON_LIGHT = '#FBFBF9';
export const ON_DARK = '#101214';

export function isPureBlackOrWhite(hex: string): boolean {
  const h = String(hex).toUpperCase();
  return h === '#FFFFFF' || h === '#000000';
}

/** Límites de luminosidad HSL que evitan generar blanco/negro puros. */
const L_MIN = 0.03;
const L_MAX = 0.985;

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
  const light = Math.min(L_MAX, Math.max(L_MIN, clamp01(l)));
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
 * Chooses a readable `on` color (ON_LIGHT / ON_DARK, near-white / near-black) for a background.
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
  if (contrastRatio(ON_LIGHT, bg) >= min) return { bg, on: ON_LIGHT, changed: false };
  if (contrastRatio(ON_DARK, bg) >= min) return { bg, on: ON_DARK, changed: false };
  const { h, s, l } = hexToHsl(bg);
  for (let i = 1; i <= 50; i++) {
    const dl = 0.02 * i;
    const darker = hslToHex(h, s, clamp01(l - dl));
    if (contrastRatio(ON_LIGHT, darker) >= min) return { bg: darker, on: ON_LIGHT, changed: true };
    const lighter = hslToHex(h, s, clamp01(l + dl));
    if (contrastRatio(ON_DARK, lighter) >= min) return { bg: lighter, on: ON_DARK, changed: true };
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
  if (worst(ON_DARK) >= min) return { color: ON_DARK, changed: true };
  if (worst(ON_LIGHT) >= min) return { color: ON_LIGHT, changed: true };
  throw new Error(`THEME_INVALID: no se pudo corregir "${fg}" contra [${backgrounds.join(', ')}]`);
}

// ─── P3 (fix I1-R2): diferencia perceptual CIEDE2000 ────────────────────────

/** sRGB hex → CIELAB (D65). */
export function hexToLab(hex: string): { L: number; a: number; b: number } {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** ΔE CIEDE2000 entre dos colores hex (kL = kC = kH = 1). */
export function deltaE2000(hexA: string, hexB: string): number {
  const p = hexToLab(hexA), q = hexToLab(hexB);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(p.a, p.b), C2 = Math.hypot(q.a, q.b);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cm, 7) / (Math.pow(Cm, 7) + Math.pow(25, 7))));
  const a1 = (1 + G) * p.a, a2 = (1 + G) * q.a;
  const C1p = Math.hypot(a1, p.b), C2p = Math.hypot(a2, q.b);
  const h = (b: number, a: number) => { if (a === 0 && b === 0) return 0; const x = Math.atan2(b, a) / rad; return x < 0 ? x + 360 : x; };
  const h1 = h(p.b, a1), h2 = h(q.b, a2);
  const dL = q.L - p.L, dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * rad) / 2);
  const Lm = (p.L + q.L) / 2, Cmp = (C1p + C2p) / 2;
  let hm = h1 + h2;
  if (C1p * C2p !== 0) { if (Math.abs(h1 - h2) > 180) hm += h1 + h2 < 360 ? 360 : -360; hm /= 2; }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hm - 275) / 25, 2));
  const RC = 2 * Math.sqrt(Math.pow(Cmp, 7) / (Math.pow(Cmp, 7) + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lm - 50, 2)) / Math.sqrt(20 + Math.pow(Lm - 50, 2));
  const SC = 1 + 0.045 * Cmp, SH = 1 + 0.015 * Cmp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt(Math.pow(dL / SL, 2) + Math.pow(dC / SC, 2) + Math.pow(dH / SH, 2) + RT * (dC / SC) * (dH / SH));
}
