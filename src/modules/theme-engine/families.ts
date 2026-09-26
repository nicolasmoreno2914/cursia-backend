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
import { ThemeFamily, ThemeFamilyId, ThemeFamilyModeBase } from './types';

const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', Cambria, serif";

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
          surface: '#FFFFFF',
          surfaceAlt: '#F0F1EC',
          border: '#DCDFD5',
          borderStrong: '#8A9280',
          textPrimary: '#20261E',
          textSecondary: '#525B4F',
          textOnAccent: '#FFFFFF',
          accent: '#B45309',
          accentStrong: '#8A4006',
          accentSoft: '#FBE6C2',
          success: '#0F766E',
          warning: '#92400E',
          danger: '#B91C1C',
          info: '#1D4ED8',
          onSuccess: '#FFFFFF',
          onWarning: '#FFFFFF',
          onDanger: '#FFFFFF',
          onInfo: '#FFFFFF',
        },
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 700, lineHeading: 1.25, measureCh: 70 },
        shape: { radiusSm: 8, radiusMd: 12, radiusLg: 20, borderWidth: 1 },
        variants: { card: 'outline', callout: 'tinted', hero: 'soft' },
        moduleColors: ['#0F6E5C', '#B45309', '#1E3A5F', '#7A4E12'],
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
          surface: '#FFFFFF',
          surfaceAlt: '#EDEFF1',
          border: '#D6DBE0',
          borderStrong: '#7C8896',
          textPrimary: '#1E2124',
          textSecondary: '#52575C',
          textOnAccent: '#FFFFFF',
          accent: '#1D4ED8',
          accentStrong: '#1E3A8A',
          accentSoft: '#DBEAFE',
          success: '#047857',
          warning: '#92400E',
          danger: '#B91C1C',
          info: '#334155',
          onSuccess: '#FFFFFF',
          onWarning: '#FFFFFF',
          onDanger: '#FFFFFF',
          onInfo: '#FFFFFF',
        },
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 600, lineHeading: 1.3, measureCh: 68 },
        shape: { radiusSm: 4, radiusMd: 8, radiusLg: 12, borderWidth: 1 },
        variants: { card: 'flat', callout: 'outline', hero: 'solid' },
        moduleColors: ['#334155', '#1D4ED8', '#0F766E', '#7C2D12'],
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
          surface: '#FFFFFF',
          surfaceAlt: '#F1EEE8',
          border: '#DAD4C8',
          borderStrong: '#8B8172',
          textPrimary: '#241F19',
          textSecondary: '#5A5044',
          textOnAccent: '#FFFFFF',
          accent: '#7C2D12',
          accentStrong: '#5C210D',
          accentSoft: '#F3E2D7',
          success: '#3F6212',
          warning: '#854D0E',
          danger: '#991B1B',
          info: '#1E3A5F',
          onSuccess: '#FFFFFF',
          onWarning: '#FFFFFF',
          onDanger: '#FFFFFF',
          onInfo: '#FFFFFF',
        },
        typography: { fontBody: SERIF, fontHeading: SERIF, weightHeading: 700, lineHeading: 1.2, measureCh: 62 },
        shape: { radiusSm: 2, radiusMd: 4, radiusLg: 8, borderWidth: 1 },
        variants: { card: 'flat', callout: 'outline', hero: 'soft' },
        moduleColors: ['#7C2D12', '#1E3A5F', '#3F6212', '#5B3A8E'],
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
          surface: '#FFFFFF',
          surfaceAlt: '#E9EDEF',
          border: '#CBD3D8',
          borderStrong: '#5F6B73',
          textPrimary: '#12181C',
          textSecondary: '#4A555C',
          textOnAccent: '#FFFFFF',
          accent: '#0E7490',
          accentStrong: '#0B5A70',
          accentSoft: '#CFFAFE',
          success: '#0F766E',
          warning: '#92400E',
          danger: '#B91C1C',
          info: '#1D4ED8',
          onSuccess: '#FFFFFF',
          onWarning: '#FFFFFF',
          onDanger: '#FFFFFF',
          onInfo: '#FFFFFF',
        },
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 600, lineHeading: 1.3, measureCh: 74 },
        shape: { radiusSm: 0, radiusMd: 2, radiusLg: 4, borderWidth: 1 },
        variants: { card: 'outline', callout: 'flat', hero: 'solid' },
        moduleColors: ['#0E7490', '#B45309', '#334155', '#3F6212'],
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
        moduleColors: ['#22D3EE', '#FBBF24', '#818CF8', '#4ADE80'],
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
          surface: '#FFFFFF',
          surfaceAlt: '#F5EBF1',
          border: '#E7D3DF',
          borderStrong: '#93697F',
          textPrimary: '#251621',
          textSecondary: '#5C4453',
          textOnAccent: '#FFFFFF',
          accent: '#C026D3',
          accentStrong: '#8B1E96',
          accentSoft: '#F5D0FE',
          success: '#15803D',
          warning: '#B45309',
          danger: '#DC2626',
          info: '#4338CA',
          onSuccess: '#FFFFFF',
          onWarning: '#FFFFFF',
          onDanger: '#FFFFFF',
          onInfo: '#FFFFFF',
        },
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 800, lineHeading: 1.25, measureCh: 68 },
        shape: { radiusSm: 12, radiusMd: 20, radiusLg: 32, borderWidth: 2 },
        variants: { card: 'tinted', callout: 'tinted', hero: 'solid' },
        moduleColors: ['#C026D3', '#0EA5E9', '#65A30D', '#F97316', '#DB2777'],
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
        typography: { fontBody: SANS, fontHeading: SANS, weightHeading: 700, lineHeading: 1.28, measureCh: 68 },
        shape: { radiusSm: 8, radiusMd: 14, radiusLg: 24, borderWidth: 1 },
        variants: { card: 'tinted', callout: 'outline', hero: 'solid' },
        moduleColors: ['#1A3C5E', '#0B6B56', '#7D3C98', '#9B1C1C'],
      }),
    },
  },
};

/** Deterministic px scale, 4/8 rhythm (audit §H.2). Same for every family/mode. */
export const SPACE_SCALE: number[] = [0, 4, 8, 12, 16, 24, 32, 48, 64];
