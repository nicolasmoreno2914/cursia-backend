/**
 * R1 — Theme Engine: THEME_FAMILIES catalog (data-driven, one object per
 * family/mode, per audit §H.4). Base tokens here are a reasonable starting
 * point — resolveTheme() still runs every base through the same contrast
 * auto-correction as a seeded theme, so hand-picked hex values do not need
 * to be perfect, only close.
 *
 * Fonts are system stacks only (no webfonts — Moodle labels can't load
 * external CSS reliably, see CLAUDE.md "Moodle filtra el HTML").
 */
import { EduBlockRole, ThemeFamily, ThemeFamilyId, ThemeFamilyModeBase, ThemeMode, ThemePersonality } from './types';

const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
/** R14-A — pilas de sistema con personalidad (sin webfonts: Moodle/CSP/offline). */
const HUMANIST = "'Avenir Next', Avenir, 'Segoe UI', Candara, 'Trebuchet MS', Roboto, sans-serif";
const ROUNDED = "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', 'Avenir Next', 'Segoe UI', Roboto, sans-serif";
const SERIF_TEXT = "Charter, 'Bitstream Charter', 'Iowan Old Style', Georgia, Cambria, 'Times New Roman', serif";
const SERIF_DISPLAY = "'Iowan Old Style', 'Palatino Linotype', Palatino, Charter, Georgia, serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
/** Pila serif histórica (se conserva exportada para compatibilidad de fixtures). */
const SERIF = "Georgia, 'Times New Roman', Cambria, serif";
void SERIF;

function persona(p: ThemePersonality): ThemePersonality {
  return p;
}

function base(partial: ThemeFamilyModeBase): ThemeFamilyModeBase {
  return partial;
}

export const THEME_FAMILIES: Record<ThemeFamilyId, ThemeFamily> = {
  'aula-clara': {
    id: 'aula-clara',
    label: 'Aula Clara',
    supportedModes: ['light'],
    defaultMode: 'light',
    modes: {
      light: base({
        color: {
          bg: '#FAFAF7',
          surface: '#FEFEFD',
          surfaceAlt: '#F0F1EC',
          border: '#DCDFD5',
          borderStrong: '#8A9280',
          textPrimary: '#20261E',
          textSecondary: '#525B4F',
          textOnAccent: '#FBFBF9',
          accent: '#B45309',
          accentStrong: '#8A4006',
          accentSoft: '#FBE6C2',
          success: '#0F766E',
          warning: '#92400E',
          danger: '#B91C1C',
          info: '#1D4ED8',
          onSuccess: '#FBFBF9',
          onWarning: '#FBFBF9',
          onDanger: '#FBFBF9',
          onInfo: '#FBFBF9',
        },
        typography: { fontBody: HUMANIST, fontHeading: HUMANIST, weightHeading: 700, lineHeading: 1.25, measureCh: 70 },
        shape: { radiusSm: 8, radiusMd: 12, radiusLg: 20, borderWidth: 1 },
        variants: { card: 'outline', callout: 'tinted', hero: 'soft' },
        // P3 (fix I1): anclas en las dos ventanas libres de tonos de rol (verde musgo/oliva 58–123° y
        // ciruela/frambuesa 284–338°): el color de módulo es estructura, nunca se lee como un rol.
        moduleColors: ['#2F6B1F', '#7A2E73', '#5F6410', '#9C2463'],
        personality: persona({ fontDisplay: HUMANIST, fontMeta: HUMANIST, fontNumeral: HUMANIST, displayWeight: 700, thesisItalic: false, heroTreatment: 'rule', density: 'regular', ruleBetween: false, metaTracking: 0.08, plate: false, sectionRule: false, gridRules: false, metaCase: 'sentence' }),
      }),
    },
  },

  institucional: {
    id: 'institucional',
    label: 'Institucional',
    supportedModes: ['light'],
    defaultMode: 'light',
    modes: {
      light: base({
        color: {
          bg: '#F8F9FA',
          surface: '#FEFEFD',
          surfaceAlt: '#EDEFF1',
          border: '#D6DBE0',
          borderStrong: '#7C8896',
          textPrimary: '#1E2124',
          textSecondary: '#52575C',
          textOnAccent: '#FBFBF9',
          accent: '#1D4ED8',
          accentStrong: '#1E3A8A',
          accentSoft: '#DBEAFE',
          success: '#047857',
          warning: '#92400E',
          danger: '#B91C1C',
          info: '#334155',
          onSuccess: '#FBFBF9',
          onWarning: '#FBFBF9',
          onDanger: '#FBFBF9',
          onInfo: '#FBFBF9',
        },
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 600, lineHeading: 1.3, measureCh: 68 },
        shape: { radiusSm: 4, radiusMd: 8, radiusLg: 12, borderWidth: 1 },
        variants: { card: 'flat', callout: 'outline', hero: 'solid' },
        // P3 (fix I1): anclas fuera de los tonos de rol pedagógico.
        moduleColors: ['#5E2D6B', '#56611A', '#7A1F4E', '#2F5A1C'],
        personality: persona({ fontDisplay: SANS, fontMeta: SANS, fontNumeral: SANS, displayWeight: 700, thesisItalic: false, heroTreatment: 'band', density: 'regular', ruleBetween: false, metaTracking: 0.1, plate: false, sectionRule: true, gridRules: false, metaCase: 'upper' }),
      }),
    },
  },

  editorial: {
    id: 'editorial',
    label: 'Editorial',
    supportedModes: ['light'],
    defaultMode: 'light',
    modes: {
      light: base({
        color: {
          bg: '#FBFAF8',
          surface: '#FEFEFD',
          surfaceAlt: '#F1EEE8',
          border: '#DAD4C8',
          borderStrong: '#8B8172',
          textPrimary: '#241F19',
          textSecondary: '#5A5044',
          textOnAccent: '#FBFBF9',
          accent: '#7C2D12',
          accentStrong: '#5C210D',
          accentSoft: '#F3E2D7',
          success: '#3F6212',
          warning: '#854D0E',
          danger: '#991B1B',
          info: '#1E3A5F',
          onSuccess: '#FBFBF9',
          onWarning: '#FBFBF9',
          onDanger: '#FBFBF9',
          onInfo: '#FBFBF9',
        },
        typography: { fontBody: SERIF_TEXT, fontHeading: SERIF_DISPLAY, weightHeading: 600, lineHeading: 1.2, measureCh: 62 },
        shape: { radiusSm: 2, radiusMd: 4, radiusLg: 8, borderWidth: 1 },
        variants: { card: 'flat', callout: 'outline', hero: 'soft' },
        // P3 (fix I1): anclas fuera de los tonos de rol pedagógico.
        moduleColors: ['#7C123E', '#5F2A6B', '#3F6212', '#5E6412'],
        personality: persona({ fontDisplay: SERIF_DISPLAY, fontMeta: SANS, fontNumeral: SERIF_DISPLAY, displayWeight: 600, thesisItalic: false, heroTreatment: 'rule', density: 'airy', ruleBetween: true, metaTracking: 0.12, plate: false, sectionRule: false, gridRules: false, metaCase: 'upper' }),
      }),
    },
  },

  tecnico: {
    id: 'tecnico',
    label: 'Técnico',
    supportedModes: ['light', 'dark'],
    defaultMode: 'light',
    modes: {
      light: base({
        color: {
          bg: '#F5F7F8',
          surface: '#FEFEFD',
          surfaceAlt: '#E9EDEF',
          border: '#CBD3D8',
          borderStrong: '#5F6B73',
          textPrimary: '#12181C',
          textSecondary: '#4A555C',
          textOnAccent: '#FBFBF9',
          accent: '#0E7490',
          accentStrong: '#0B5A70',
          accentSoft: '#CFFAFE',
          success: '#0F766E',
          warning: '#92400E',
          danger: '#B91C1C',
          info: '#1D4ED8',
          onSuccess: '#FBFBF9',
          onWarning: '#FBFBF9',
          onDanger: '#FBFBF9',
          onInfo: '#FBFBF9',
        },
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 600, lineHeading: 1.3, measureCh: 74 },
        shape: { radiusSm: 0, radiusMd: 2, radiusLg: 4, borderWidth: 1 },
        variants: { card: 'outline', callout: 'flat', hero: 'solid' },
        // P3 (fix I1): anclas fuera de los tonos de rol pedagógico.
        moduleColors: ['#3F6212', '#6B2E7A', '#5F6410', '#8A2257'],
        personality: persona({ fontDisplay: SANS, fontMeta: MONO, fontNumeral: MONO, displayWeight: 700, thesisItalic: false, heroTreatment: 'rule', density: 'compact', ruleBetween: false, metaTracking: 0.04, plate: false, sectionRule: false, gridRules: true, metaCase: 'upper' }),
      }),
      dark: base({
        color: {
          bg: '#070C14',
          surface: '#0E1620',
          surfaceAlt: '#141E2B',
          border: '#22303F',
          borderStrong: '#5C7080',
          textPrimary: '#E7EEF3',
          textSecondary: '#A9B7C2',
          textOnAccent: '#031014',
          accent: '#22D3EE',
          accentStrong: '#67E8F9',
          accentSoft: '#0B3A44',
          success: '#34D399',
          warning: '#FBBF24',
          danger: '#F87171',
          info: '#60A5FA',
          onSuccess: '#052014',
          onWarning: '#221600',
          onDanger: '#210404',
          onInfo: '#04101F',
        },
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 600, lineHeading: 1.3, measureCh: 74 },
        shape: { radiusSm: 0, radiusMd: 2, radiusLg: 4, borderWidth: 1 },
        variants: { card: 'outline', callout: 'flat', hero: 'solid' },
        // P3 (fix I1): anclas fuera de los tonos de rol pedagógico.
        moduleColors: ['#A3D65C', '#D58AE6', '#B8D65C', '#F08AB8'],
        personality: persona({ fontDisplay: SANS, fontMeta: MONO, fontNumeral: MONO, displayWeight: 700, thesisItalic: false, heroTreatment: 'rule', density: 'compact', ruleBetween: false, metaTracking: 0.04, plate: true, sectionRule: false, gridRules: true, metaCase: 'upper' }),
      }),
    },
  },

  vibrante: {
    id: 'vibrante',
    label: 'Vibrante',
    supportedModes: ['light'],
    defaultMode: 'light',
    modes: {
      light: base({
        color: {
          bg: '#FDFAFB',
          surface: '#FEFEFD',
          surfaceAlt: '#F5EBF1',
          border: '#E7D3DF',
          borderStrong: '#93697F',
          textPrimary: '#251621',
          textSecondary: '#5C4453',
          textOnAccent: '#FBFBF9',
          accent: '#C026D3',
          accentStrong: '#8B1E96',
          accentSoft: '#F5D0FE',
          success: '#15803D',
          warning: '#B45309',
          danger: '#DC2626',
          info: '#4338CA',
          onSuccess: '#FBFBF9',
          onWarning: '#FBFBF9',
          onDanger: '#FBFBF9',
          onInfo: '#FBFBF9',
        },
        typography: { fontBody: HUMANIST, fontHeading: ROUNDED, weightHeading: 800, lineHeading: 1.25, measureCh: 68 },
        shape: { radiusSm: 12, radiusMd: 20, radiusLg: 28, borderWidth: 1 },
        variants: { card: 'tinted', callout: 'tinted', hero: 'solid' },
        // P3 (fix I1): anclas fuera de los tonos de rol pedagógico.
        moduleColors: ['#C026D3', '#65A30D', '#D42372', '#5B8A0A', '#8C1FAD'],
        personality: persona({ fontDisplay: ROUNDED, fontMeta: ROUNDED, fontNumeral: ROUNDED, displayWeight: 800, thesisItalic: false, heroTreatment: 'plate', density: 'regular', ruleBetween: false, metaTracking: 0.06, plate: false, sectionRule: false, gridRules: false, metaCase: 'upper' }),
      }),
    },
  },

  'oscuro-premium': {
    id: 'oscuro-premium',
    label: 'Oscuro Premium',
    supportedModes: ['dark'],
    defaultMode: 'dark',
    modes: {
      dark: base({
        color: {
          bg: '#060F1C',
          surface: '#0D1A2B',
          surfaceAlt: '#122439',
          border: '#25405C',
          borderStrong: '#6C90B3',
          textPrimary: '#F1F5F9',
          textSecondary: '#B7C4D3',
          textOnAccent: '#1B0E00',
          accent: '#E8692A',
          accentStrong: '#F5934F',
          accentSoft: '#3A2211',
          success: '#34D399',
          warning: '#FBBF24',
          danger: '#F87171',
          info: '#93C5FD',
          onSuccess: '#052014',
          onWarning: '#221600',
          onDanger: '#210404',
          onInfo: '#04101F',
        },
        typography: { fontBody: HUMANIST, fontHeading: HUMANIST, weightHeading: 700, lineHeading: 1.28, measureCh: 68 },
        shape: { radiusSm: 8, radiusMd: 14, radiusLg: 20, borderWidth: 1 },
        variants: { card: 'tinted', callout: 'outline', hero: 'solid' },
        // P3 (fix I1): ciruela, oliva, frambuesa y musgo (fuera de los tonos de rol del modo oscuro).
        moduleColors: ['#6B2E7A', '#4E6B12', '#8A2257', '#2E5E1E'],
        personality: persona({ fontDisplay: HUMANIST, fontMeta: HUMANIST, fontNumeral: HUMANIST, displayWeight: 700, thesisItalic: false, heroTreatment: 'rule', density: 'regular', ruleBetween: false, metaTracking: 0.06, plate: true, sectionRule: false, gridRules: false, metaCase: 'sentence' }),
      }),
    },
  },
};

/**
 * P3 — tonos de bloque por modo (semánticos, compartidos por las familias). Verificados por
 * validateTheme: ink ≥ 4.5 sobre soft y sobre bg/surface; textPrimary ≥ 4.5 sobre soft; onInk ≥ 4.5 sobre ink.
 */
export const EDU_BLOCKS: Record<ThemeMode, Record<EduBlockRole, { ink: string; soft: string; edge: string }>> = {
  light: {
    concepto: { ink: '#1D4FB8', soft: '#EAF1FD', edge: '#BFD2F4' },
    ejemplo: { ink: '#13683A', soft: '#E6F4EA', edge: '#B4DCC1' },
    caso: { ink: '#5B35AE', soft: '#F0EBFB', edge: '#D3C6F0' },
    error: { ink: '#B3261E', soft: '#FDECEA', edge: '#F2C3BD' },
    proceso: { ink: '#8A4B00', soft: '#FDF1DC', edge: '#EDCF9C' },
    decision: { ink: '#0A6570', soft: '#E1F3F4', edge: '#A6D7DB' },
    reflexion: { ink: '#6B4E33', soft: '#F5EFE6', edge: '#DECDB8' },
    visual: { ink: '#34496A', soft: '#EDF1F6', edge: '#C7D1DF' },
  },
  dark: {
    concepto: { ink: '#93B8FF', soft: '#13243F', edge: '#2B4877' },
    ejemplo: { ink: '#74D69E', soft: '#0F2A1F', edge: '#25563C' },
    caso: { ink: '#C3ABFF', soft: '#221B3D', edge: '#463970' },
    error: { ink: '#FF9F95', soft: '#33171A', edge: '#6A2F31' },
    proceso: { ink: '#F5C469', soft: '#2D2211', edge: '#5D481B' },
    decision: { ink: '#72D6DF', soft: '#0E2A30', edge: '#24555C' },
    reflexion: { ink: '#E2C6A4', soft: '#29221A', edge: '#554532' },
    visual: { ink: '#AEC0D9', soft: '#18263A', edge: '#35496A' },
  },
};

/** Deterministic px scale, 4/8 rhythm (audit §H.2). Same for every family/mode. */
export const SPACE_SCALE: number[] = [0, 4, 8, 12, 16, 24, 32, 48, 64];
