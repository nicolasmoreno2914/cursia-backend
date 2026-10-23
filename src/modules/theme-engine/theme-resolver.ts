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
  deltaE2000,
  hexToHsl,
  hslToHex,
  isPureBlackOrWhite,
  isValidHex,
  normalizeHex,
  ON_DARK,
  ON_LIGHT,
  resolveReadableOn,
} from './color-math';
import { EDU_BLOCKS, SPACE_SCALE, THEME_FAMILIES } from './families';
import {
  BrandSeed,
  ModuleColor,
  PresentationProfileInput,
  ResolvedTheme,
  ThemeColorTokens,
  ThemeMode,
  ThemeValidationError,
  THEME_ENGINE_VERSION,
  EDU_BLOCK_ROLES,
  EduBlockRole,
  EduBlockTone,
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
  const strongWhiteOk = contrastRatio(ON_LIGHT, accentStrongFixed) >= min;
  const strongBlackOk = contrastRatio(ON_DARK, accentStrongFixed) >= min;
  const preferred = strongWhiteOk ? ON_LIGHT : strongBlackOk ? ON_DARK : null;
  if (!preferred) {
    throw new Error(`THEME_INVALID: accentStrong "${accentStrongFixed}" no admite ningún texto legible`);
  }
  if (contrastRatio(preferred, accent) >= min) {
    return { accent, on: preferred, changed: false };
  }
  const { h, s, l } = hexToHsl(accent);
  const darken = preferred === ON_LIGHT;
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

/** Un color de la semilla que sea blanco/negro puro se sustituye por ON_LIGHT/ON_DARK (§G.4), registrándolo. */
function nudgePure(hex: string, label: string, adjustments: string[]): string {
  const h = normalizeHex(hex);
  if (!isPureBlackOrWhite(h)) return h;
  const out = h === '#FFFFFF' ? ON_LIGHT : ON_DARK;
  adjustments.push(`${label} ${h} es blanco/negro puro; se usa ${out}`);
  return out;
}

function deriveModuleColorsBasis(
  familyModuleColors: string[],
  brandSeed: BrandSeed | undefined,
  adjustments: string[],
): string[] {
  const seedColors = (brandSeed?.moduleColors ?? []).filter((c) => typeof c === 'string' && c.length > 0);
  if (seedColors.length > 0) return seedColors.map((c, i) => nudgePure(c, `brandSeed.moduleColors[${i}]`, adjustments));
  return familyModuleColors.map(normalizeHex);
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
  if (input.themeVersion !== undefined && input.themeVersion !== THEME_ENGINE_VERSION) {
    // Un tema etiquetado con otra versión pero construido con las reglas v1 mentiría y
    // cambiaría themeSha256 (clave de reuse) sin cambiar el resultado.
    throw new Error(
      `THEME_INVALID: themeVersion ${String(input.themeVersion)} no soportada (este motor es v${THEME_ENGINE_VERSION})`,
    );
  }

  const adjustments: string[] = [];
  const color: ThemeColorTokens = { ...baseMode.color };

  // ── accent / accentStrong / textOnAccent ──────────────────────────────
  if (input.brandSeed?.accent) {
    color.accent = nudgePure(input.brandSeed.accent, 'brandSeed.accent', adjustments);
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

  const moduleColorsBasis = deriveModuleColorsBasis(baseMode.moduleColors, input.brandSeed, adjustments);

  const theme: ResolvedTheme = {
    version: THEME_ENGINE_VERSION,
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
      // R14-A — escala editorial (Design Language V1 §1).
      // P3 — escala de curso (no de revista): 34 / 24 / 19 / 18 / 16, display ≤ 40 px en escritorio.
      sizeDisplayPx: 32,
      sizeTitlePx: 24,
      sizeItemPx: 19,
      sizeLeadPx: 20,
      sizeStatementPx: 22,
      sizeNumeralPx: 28,
      scale: {
        display: 'clamp(1.75rem, 1.35rem + 1.6vw, 2.5rem)',
        title: 'clamp(1.3125rem, 1.15rem + 0.7vw, 1.625rem)',
        item: 'clamp(1.125rem, 1.07rem + 0.25vw, 1.25rem)',
        lead: 'clamp(1.125rem, 1.05rem + 0.4vw, 1.3125rem)',
        statement: 'clamp(1.25rem, 1.1rem + 0.6vw, 1.5rem)',
        numeral: 'clamp(1.75rem, 1.5rem + 1vw, 2.25rem)',
      },
    },
    space: [...SPACE_SCALE],
    shape: { ...baseMode.shape },
    variants: { ...baseMode.variants },
    personality: { ...baseMode.personality },
    blocks: resolveBlocks(input.mode),
    adjustments,
    moduleColorsBasis,
    moduleColorsSource: (input.brandSeed?.moduleColors ?? []).some((c) => typeof c === 'string' && c.length > 0) ? 'brand' : 'family',
  };

  // Correcciones de los colores de módulo ancla (semilla o familia), registradas (§H.5).
  adjustments.push(...moduleColorAdjustments(theme, moduleColorsBasis.length));

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

/** P3 — tonos de bloque del modo + `onInk` legible; falla fuerte si un tono no llega al contraste. */
function resolveBlocks(mode: ThemeMode): Record<EduBlockRole, EduBlockTone> {
  const src = EDU_BLOCKS[mode];
  const out = {} as Record<EduBlockRole, EduBlockTone>;
  for (const role of EDU_BLOCK_ROLES) {
    const b = src[role];
    const on = contrastRatio(ON_LIGHT, b.ink) >= CONTRAST_BODY ? ON_LIGHT : ON_DARK;
    out[role] = { ink: b.ink, soft: b.soft, edge: b.edge, onInk: on };
  }
  return out;
}

interface ModuleColorsComputation {
  colors: ModuleColor[];
  /** Notas de corrección por índice (vacío si el color se usó tal cual). */
  notes: string[][];
}

function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Dos `main` vecinos son indistinguibles si difieren poco en contraste Y en tono. */
function tooSimilar(a: string, b: string): boolean {
  return a === b || (contrastRatio(a, b) < 1.2 && hueDelta(hexToHsl(a).h, hexToHsl(b).h) < 20);
}

/**
 * P3 (fix I1) — el color de módulo es ESTRUCTURA y nunca debe leerse como un rol pedagógico: su tono
 * queda a ≥ ROLE_HUE_MIN_DISTANCE° del tono de todo `ink` de rol (theme.blocks) del modo. Un color casi
 * gris (saturación < MODULE_NEUTRAL_SAT) no tiene tono y queda exento.
 */
export const ROLE_HUE_MIN_DISTANCE = 25;
export const MODULE_NEUTRAL_SAT = 0.15;
/** Margen al desplazar (redondeo hex ↔ hsl): el tono final queda a ≥ 27° para que el check de 25° pase siempre. */
const ROLE_HUE_TARGET = ROLE_HUE_MIN_DISTANCE + 2;

function roleHues(theme: ResolvedTheme): number[] {
  return theme.blocks ? EDU_BLOCK_ROLES.map((r) => hexToHsl(theme.blocks[r].ink).h) : [];
}

/** Distancia mínima (°) de un tono a los tonos de rol. */
export function roleHueDistance(theme: ResolvedTheme, hex: string): number {
  const { h } = hexToHsl(hex);
  return Math.min(...roleHues(theme).map((r) => hueDelta(h, r)), 360);
}

/** El color de módulo `i` es de Cursia (no de la marca del cliente): anclas de familia o módulos generados. */
function cursiaOwned(theme: ResolvedTheme, i: number, basisLength: number): boolean {
  return theme.moduleColorsSource !== 'brand' || i >= basisLength;
}

/**
 * P3 (fix I1-R2): las anclas por defecto de Cursia quedan PERCEPTUALMENTE lejos de todo rol: ΔE2000 ≥
 * DEFAULT_MODULE_MIN_DELTA_E entre el tono del módulo (ink y relleno de moduleTone, y el main) y cada ink de rol.
 */
export const DEFAULT_MODULE_MIN_DELTA_E = 20;

/** Tono más cercano a `h` que queda a ≥ ROLE_HUE_TARGET de todo rol (determinista: +d antes que −d). */
function roleSafeHue(h: number, roles: number[]): number {
  const ok = (x: number) => roles.every((r) => hueDelta(x, r) >= ROLE_HUE_TARGET);
  if (ok(h)) return h;
  for (let d = 1; d <= 180; d++) {
    const up = (h + d) % 360;
    if (ok(up)) return up;
    const down = (h - d + 360) % 360;
    if (ok(down)) return down;
  }
  return h;
}

/** soft/border/on de un color de módulo ya decidido (misma receta que computeModuleColors). */
function moduleColorFrom(main: string, h: number, s: number, isDark: boolean): ModuleColor {
  const m = resolveReadableOn(main, CONTRAST_BODY);
  const soft = resolveReadableOn(hslToHex(h, Math.min(s, isDark ? 0.35 : 0.3), isDark ? 0.22 : 0.92), CONTRAST_BODY);
  return { main: m.bg, onMain: m.on, soft: soft.bg, onSoft: soft.on, border: hslToHex(h, Math.min(s, 0.5), isDark ? 0.42 : 0.55) };
}

/** Margen sobre DEFAULT_MODULE_MIN_DELTA_E para los candidatos generados (redondeo y variaciones de familia). */
const GENERATED_DELTA_E_MARGIN = 0.5;
const POOL_CACHE = new Map<string, string[]>();

/**
 * P3 (fix I1-R3): candidatos para módulos generados en este tema: legibles tal cual (el main no se corrige por
 * contraste y vale como ink de moduleTone: ≥ 4.5 sobre su soft y sobre bg/surface), sin verde, a ≥ 27° de tono
 * de todo rol y a ΔE2000 ≥ 20.5 de todo ink de rol. Orden determinista (tono, saturación, luminosidad).
 */
function generatedPool(theme: ResolvedTheme): string[] {
  const isDark = theme.mode === 'dark';
  const inks = EDU_BLOCK_ROLES.map((r) => theme.blocks[r].ink);
  const key = [theme.mode, theme.color.bg, theme.color.surface, ...inks].join('|');
  const hit = POOL_CACHE.get(key);
  if (hit) return hit;
  const roles = roleHues(theme);
  const out: string[] = [];
  const ls = isDark ? [0.5, 0.56, 0.62, 0.68, 0.74, 0.8] : [0.18, 0.22, 0.26, 0.3, 0.34, 0.38, 0.42];
  for (let h = 0; h < 360; h += 4) {
    for (const s of [0.08, 0.12, 0.4, 0.55, 0.7, 0.85]) {
      const neutral = s < MODULE_NEUTRAL_SAT;
      if (!neutral && h >= 80 && h <= 175) continue; // sin verde (verde = rol «ejemplo»)
      if (!neutral && roles.some((r) => hueDelta(h, r) < ROLE_HUE_TARGET)) continue;
      for (const l of ls) {
        const hex = hslToHex(h, s, l);
        if (resolveReadableOn(hex, CONTRAST_BODY).bg !== hex) continue;
        const { h: hh, s: ss } = hexToHsl(hex);
        const soft = isDark ? hslToHex(hh, Math.min(ss, 0.4), 0.17) : resolveReadableOn(hslToHex(hh, Math.min(ss, 0.3), 0.92), CONTRAST_BODY).bg;
        if (contrastRatio(hex, soft) < CONTRAST_BODY || contrastRatio(hex, theme.color.bg) < CONTRAST_BODY || contrastRatio(hex, theme.color.surface) < CONTRAST_BODY) continue;
        if (inks.some((ink) => deltaE2000(hex, ink) < DEFAULT_MODULE_MIN_DELTA_E + GENERATED_DELTA_E_MARGIN)) continue;
        out.push(hex);
      }
    }
  }
  POOL_CACHE.set(key, out);
  return out;
}

/** Candidato del conjunto seguro más distinto (máx–mín ΔE) de los módulos anteriores; null si no hay conjunto. */
function pickGeneratedModule(theme: ResolvedTheme, prev: string[]): string | null {
  if (!theme.blocks) return null;
  const pool = generatedPool(theme);
  let best: string | null = null;
  let bestD = -1;
  for (const c of pool) {
    if (prev.includes(c)) continue;
    // vecino inmediato: nunca «demasiado parecido» (misma regla que las anclas) y a ΔE ≥ 10
    if (prev.length && (tooSimilar(c, prev[prev.length - 1]) || deltaE2000(c, prev[prev.length - 1]) < 10)) continue;
    const d = prev.length ? Math.min(...prev.map((p) => deltaE2000(c, p))) : 100;
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Calcula los colores de módulo 0..count-1 en orden.
 *
 * - Índices < anclas: el ancla i (BrandSeed.moduleColors[i] o el ancla i de la familia) se
 *   usa CON SU PROPIO tono y saturación; solo se corrige la luminosidad para contraste con
 *   su `on` (resolveReadableOn), y se anota.
 * - Índices ≥ anclas: rotación por ángulo áureo desde el primer ancla (N arbitrario).
 * - Colisión con el anterior (o igualdad con cualquiera previo): se desplaza primero la
 *   luminosidad y, si no alcanza, el tono; se anota.
 * Pura y determinista: depende solo de (theme, count).
 */
function computeModuleColors(theme: ResolvedTheme, count: number): ModuleColorsComputation {
  const basis = theme.moduleColorsBasis.length > 0 ? theme.moduleColorsBasis : [theme.color.accent];
  const isDark = theme.mode === 'dark';
  const colors: ModuleColor[] = [];
  const notes: string[][] = [];
  const hue0 = hexToHsl(basis[0]).h;

  for (let i = 0; i < count; i++) {
    const note: string[] = [];
    let h: number;
    let s: number;
    let l: number;
    let baseHex: string;
    if (i < basis.length) {
      baseHex = basis[i];
      ({ h, s, l } = hexToHsl(baseHex));
    } else {
      // P3 (fix I1-R3): un módulo GENERADO (más allá de las anclas de la familia o de la marca) es de Cursia:
      // sale del conjunto seguro (ΔE2000 ≥ 20 contra todo rol, sin verde, legible) eligiendo el candidato más
      // distinto de los módulos anteriores (máx–mín ΔE). Determinista.
      const prev = colors.map((c) => c.main);
      const pick = pickGeneratedModule(theme, prev);
      if (pick) {
        const { h: ph, s: ps, l: pl } = hexToHsl(pick);
        colors.push(moduleColorFrom(pick, ph, ps, isDark));
        notes.push(note);
        continue;
      }
      h = (hue0 + GOLDEN_ANGLE_DEG * i) % 360;
      s = Math.max(hexToHsl(basis[i % basis.length]).s, 0.45);
      l = isDark ? 0.58 : 0.4;
      baseHex = hslToHex(h, s, l);
    }

    // P3 (fix I1 / I1-R1): fuera de los tonos de rol SOLO los colores de Cursia (anclas de la familia y
    // módulos generados más allá de las anclas). Un color de MARCA (semilla) nunca se altera: los bloques
    // de rol se distinguen igual por ícono + rótulo + tinte.
    const roles = cursiaOwned(theme, i, basis.length) ? roleHues(theme) : [];
    if (s >= MODULE_NEUTRAL_SAT && roles.length) {
      const safe = roleSafeHue(h, roles);
      if (safe !== h) {
        const before = baseHex;
        h = safe;
        // El tono desplazado cae en verde-oliva o ciruela-frambuesa: saturación y luminosidad sobrias
        // (sin neones) para que siga leyéndose como un color institucional de estructura.
        s = Math.min(s, 0.55);
        l = isDark ? Math.min(Math.max(l, 0.3), 0.45) : Math.min(l, 0.32);
        baseHex = hslToHex(h, s, l);
        if (i < basis.length) note.push(`moduleColor(${i}) desplazado fuera de los tonos de rol pedagógico (${before} → ${baseHex})`);
      }
    }
    let main = resolveReadableOn(baseHex, CONTRAST_BODY);
    if (main.changed && i < basis.length) {
      note.push(`moduleColor(${i}).main corregido para contraste ≥ ${CONTRAST_BODY} (${baseHex} → ${main.bg})`);
    }
    const collides = (hex: string) =>
      (i > 0 && tooSimilar(hex, colors[i - 1].main)) || colors.some((c) => c.main === hex);
    if (collides(main.bg)) {
      const before = main.bg;
      const shifts = [0.14, -0.14, 0.28, -0.28];
      let fixed = false;
      for (const dl of shifts) {
        const cand = resolveReadableOn(hslToHex(h, s, clamp01(l + dl)), CONTRAST_BODY);
        if (!collides(cand.bg)) {
          main = cand;
          fixed = true;
          break;
        }
      }
      for (let k = 1; !fixed && k <= 24; k++) {
        const hk = roles.length ? roleSafeHue((h + GOLDEN_ANGLE_DEG * k) % 360, roles) : h + GOLDEN_ANGLE_DEG * k;
        const cand = resolveReadableOn(hslToHex(hk, Math.max(s, 0.45), l), CONTRAST_BODY);
        if (!collides(cand.bg)) {
          main = cand;
          fixed = true;
        }
      }
      if (!fixed) throw new Error(`THEME_INVALID: no se pudo distinguir moduleColor(${i}) de sus vecinos`);
      h = hexToHsl(main.bg).h;
      note.push(`moduleColor(${i}).main ajustado por parecido con un módulo anterior (${before} → ${main.bg})`);
    }

    const softResolved = resolveReadableOn(hslToHex(h, Math.min(s, isDark ? 0.35 : 0.3), isDark ? 0.22 : 0.92), CONTRAST_BODY);
    colors.push({
      main: main.bg,
      onMain: main.on,
      soft: softResolved.bg,
      onSoft: softResolved.on,
      border: hslToHex(h, Math.min(s, 0.5), isDark ? 0.42 : 0.55),
    });
    notes.push(note);
  }
  return { colors, notes };
}

/**
 * Color de módulo determinista para cualquier índice ≥ 0 (ver computeModuleColors):
 * los anclas de la BrandSeed se respetan en orden (m1 → módulo 0, m2 → módulo 1, …).
 */
export function moduleColor(theme: ResolvedTheme, moduleIndex0: number): ModuleColor {
  if (!Number.isInteger(moduleIndex0) || moduleIndex0 < 0) {
    throw new Error(`THEME_INVALID: moduleIndex0 debe ser un entero ≥ 0 (recibido ${moduleIndex0})`);
  }
  return computeModuleColors(theme, moduleIndex0 + 1).colors[moduleIndex0];
}

/** Correcciones aplicadas a los colores de módulo 0..count-1 (para registrar o auditar). */
export function moduleColorAdjustments(theme: ResolvedTheme, count: number): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`THEME_INVALID: count debe ser un entero ≥ 0 (recibido ${count})`);
  }
  return computeModuleColors(theme, count).notes.flat();
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

  function checkNotPure(value: unknown, path: string) {
    if (typeof value === 'string' && isPureBlackOrWhite(value)) {
      errors.push({ code: 'PURE_BLACK_WHITE', message: `${path}: ${value} es blanco/negro puro (§G.4)` });
    }
  }
  for (const [k, v] of Object.entries(t.color)) {
    checkHex(v, `color.${k}`);
    checkNotPure(v, `color.${k}`);
  }
  if (t.version !== THEME_ENGINE_VERSION) {
    errors.push({ code: 'VERSION', message: `version ${t.version} ≠ ${THEME_ENGINE_VERSION}` });
  }
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
    for (const k of ['main', 'soft', 'onMain', 'onSoft', 'border'] as const) checkNotPure(m[k], `moduleColor(${i}).${k}`);
    checkContrast(`moduleColor(${i}).onMain`, m.onMain, `moduleColor(${i}).main`, m.main, CONTRAST_BODY);
    // P3 (fix I1-R2 / I1-R3): los colores de Cursia quedan perceptualmente lejos de todo ink de rol.
    // fix I1-R3: TODO módulo de Cursia (anclas por defecto y generados), hasta moduleCount.
    if (t.blocks && cursiaOwned(t, i, t.moduleColorsBasis.length)) {
      for (const role of EDU_BLOCK_ROLES) {
        const d = deltaE2000(m.main, t.blocks[role].ink);
        if (d < DEFAULT_MODULE_MIN_DELTA_E) errors.push({ code: 'MODULE_ROLE_DELTAE', message: `moduleColor(${i}).main ${m.main} a ΔE2000 ${d.toFixed(1)} del rol ${role} (< ${DEFAULT_MODULE_MIN_DELTA_E})` });
      }
    }
    // P3 (fix I1): ningún color de módulo DE CURSIA (con tono) cae en el tono de un rol pedagógico.
    if (t.blocks && cursiaOwned(t, i, t.moduleColorsBasis.length) && hexToHsl(m.main).s >= MODULE_NEUTRAL_SAT && roleHueDistance(t, m.main) < ROLE_HUE_MIN_DISTANCE) {
      errors.push({ code: 'MODULE_ROLE_HUE', message: `moduleColor(${i}).main ${m.main} a ${roleHueDistance(t, m.main).toFixed(0)}° de un tono de rol (< ${ROLE_HUE_MIN_DISTANCE}°)` });
    }
    checkContrast(`moduleColor(${i}).onSoft`, m.onSoft, `moduleColor(${i}).soft`, m.soft, CONTRAST_BODY);
  }

  // P3 — tonos de bloque
  if (t.blocks) {
    for (const role of EDU_BLOCK_ROLES) {
      const b = t.blocks[role];
      if (!b) { errors.push({ code: 'BLOCK_MISSING', message: `blocks.${role} ausente` }); continue; }
      for (const k of ['ink', 'soft', 'edge', 'onInk'] as const) checkHex(b[k], `blocks.${role}.${k}`);
      checkContrast(`blocks.${role}.ink`, b.ink, `blocks.${role}.soft`, b.soft, CONTRAST_BODY);
      checkContrast(`blocks.${role}.ink`, b.ink, 'bg', c.bg, CONTRAST_BODY);
      checkContrast(`blocks.${role}.ink`, b.ink, 'surface', c.surface, CONTRAST_BODY);
      checkContrast('textPrimary', c.textPrimary, `blocks.${role}.soft`, b.soft, CONTRAST_BODY);
      checkContrast(`blocks.${role}.onInk`, b.onInk, `blocks.${role}.ink`, b.ink, CONTRAST_BODY);
    }
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
