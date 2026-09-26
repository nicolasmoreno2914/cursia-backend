/**
 * R1 — Theme Engine: verbatim copy of the frontend's legacy PALETTES
 * (campuscloud-gen/src/js/01-state.js, `var PALETTES=[...]`, lines ~256-384
 * in the v2.1 fe worktree). id + colors only, per the r1-theme brief.
 *
 * Keep this in sync with scripts/fixtures/v21-legacy-palettes.json (same 28
 * entries) — the fixture is what the Node check script loads without
 * needing ts-node; this file is what legacyPaletteThemeFallback() uses at
 * runtime.
 */
import { LegacyPalette } from './types';

export const LEGACY_PALETTES: LegacyPalette[] = [
  // ── OSCURO ──
  { id: 'navy-teal', cat: 'oscuro', m1: '#1A3C5E', m1a: '#BAD4FE', m2: '#0B6B56', m2a: '#99F6E4', m3: '#7D3C98', m3a: '#E9D5FF', accent: '#E8692A', dark: '#060F1C' },
  { id: 'ocean', cat: 'oscuro', m1: '#1B4F72', m1a: '#93C5FD', m2: '#0A766B', m2a: '#5EEAD4', m3: '#334155', m3a: '#CBD5E1', accent: '#F43F5E', dark: '#040E1A' },
  { id: 'berry', cat: 'oscuro', m1: '#6C2B3D', m1a: '#FCA5A5', m2: '#6D28D9', m2a: '#DDD6FE', m3: '#9B1C1C', m3a: '#FECACA', accent: '#10B981', dark: '#150410' },
  { id: 'slate', cat: 'oscuro', m1: '#1E293B', m1a: '#CBD5E1', m2: '#374151', m2a: '#9CA3AF', m3: '#1D4ED8', m3a: '#BFDBFE', accent: '#8B5CF6', dark: '#070C14' },
  { id: 'indigo', cat: 'oscuro', m1: '#312E81', m1a: '#C7D2FE', m2: '#0F766E', m2a: '#99F6E4', m3: '#831843', m3a: '#FBCFE8', accent: '#34D399', dark: '#06050F' },
  { id: 'medianoche', cat: 'oscuro', m1: '#1E3A5F', m1a: '#93C5FD', m2: '#064E3B', m2a: '#6EE7B7', m3: '#4C1D95', m3a: '#C4B5FD', accent: '#F59E0B', dark: '#02070F' },

  // ── PROFESIONAL ──
  { id: 'emerald', cat: 'profesional', m1: '#145A32', m1a: '#86EFAC', m2: '#78350F', m2a: '#FDE68A', m3: '#1E3A5F', m3a: '#93C5FD', accent: '#22C55E', dark: '#030E07' },
  { id: 'forest', cat: 'profesional', m1: '#1B4332', m1a: '#74C69D', m2: '#7B241C', m2a: '#FCA5A5', m3: '#1A5276', m3a: '#BAD4FE', accent: '#EF4444', dark: '#030E06' },
  { id: 'royal', cat: 'profesional', m1: '#1A237E', m1a: '#C7D2FE', m2: '#4A148C', m2a: '#E9D5FF', m3: '#880E4F', m3a: '#FBCFE8', accent: '#FBBF24', dark: '#040415' },
  { id: 'bronce', cat: 'profesional', m1: '#78350F', m1a: '#FCD34D', m2: '#14532D', m2a: '#86EFAC', m3: '#374151', m3a: '#CBD5E1', accent: '#3B82F6', dark: '#0F0600' },
  { id: 'zafiro', cat: 'profesional', m1: '#1E3A8A', m1a: '#BFDBFE', m2: '#065F46', m2a: '#6EE7B7', m3: '#7C2D12', m3a: '#FED7AA', accent: '#A78BFA', dark: '#020810' },
  { id: 'titanio', cat: 'profesional', m1: '#27272A', m1a: '#D4D4D8', m2: '#0C4A6E', m2a: '#7DD3FC', m3: '#134E4A', m3a: '#5EEAD4', accent: '#06B6D4', dark: '#070709' },

  // ── COLORIDO ──
  { id: 'cyan-tech', cat: 'colorido', m1: '#0E4B6B', m1a: '#67E8F9', m2: '#6D28D9', m2a: '#DDD6FE', m3: '#065F46', m3a: '#6EE7B7', accent: '#22D3EE', dark: '#020C14' },
  { id: 'nocturno', cat: 'colorido', m1: '#3B0764', m1a: '#D8B4FE', m2: '#9D174D', m2a: '#FBCFE8', m3: '#1E3A5F', m3a: '#93C5FD', accent: '#E879F9', dark: '#0A021A' },
  { id: 'coral-rose', cat: 'colorido', m1: '#881337', m1a: '#FDA4AF', m2: '#6D28D9', m2a: '#DDD6FE', m3: '#0C4A6E', m3a: '#7DD3FC', accent: '#FB7185', dark: '#150208' },
  { id: 'aurora', cat: 'colorido', m1: '#3730A3', m1a: '#A5B4FC', m2: '#065F46', m2a: '#34D399', m3: '#7E1D38', m3a: '#FCA5A5', accent: '#C084FC', dark: '#03020E' },

  // ── CÁLIDO ──
  { id: 'sunset', cat: 'calido', m1: '#92400E', m1a: '#FCD34D', m2: '#7B241C', m2a: '#FCA5A5', m3: '#1B4332', m3a: '#86EFAC', accent: '#F97316', dark: '#120600' },
  { id: 'sahara', cat: 'calido', m1: '#713F12', m1a: '#FDE68A', m2: '#0A5540', m2a: '#6EE7B7', m3: '#7C2D12', m3a: '#FED7AA', accent: '#84CC16', dark: '#0F0804' },
  { id: 'selva', cat: 'calido', m1: '#052E16', m1a: '#86EFAC', m2: '#7D3C98', m2a: '#E9D5FF', m3: '#7B241C', m3a: '#FCA5A5', accent: '#4ADE80', dark: '#010803' },
  { id: 'miel', cat: 'calido', m1: '#7C3505', m1a: '#FCD34D', m2: '#14532D', m2a: '#86EFAC', m3: '#155E75', m3a: '#A5F3FC', accent: '#FBBF24', dark: '#0F0700' },

  // ── CLARO ──
  { id: 'blanco-corp', cat: 'claro', mode: 'light', m1: '#1E3A5F', m1a: '#DCE9FB', m2: '#0F6E5C', m2a: '#D6F5EE', m3: '#5B3A8E', m3a: '#EAE0F7', accent: '#1D4ED8', dark: '#0F172A', bg: '#FFFFFF', text: '#1B2430', textMuted: '#475569', cardBg: '#F1F5F9', cardHeaderBg: '#E7ECF1' },
  { id: 'aula-clara', cat: 'claro', mode: 'light', m1: '#0F6E5C', m1a: '#D6F5EE', m2: '#7A4E12', m2a: '#FBE6C2', m3: '#1E3A5F', m3a: '#DCE9FB', accent: '#B45309', dark: '#111827', bg: '#FAFAF7', text: '#20261E', textMuted: '#525B4F', cardBg: '#F0F1EC', cardHeaderBg: '#E4E6DE' },
  { id: 'salud-bienestar', cat: 'claro', mode: 'light', m1: '#0F766E', m1a: '#CCFBF1', m2: '#0369A1', m2a: '#E0F2FE', m3: '#334155', m3a: '#F1F5F9', accent: '#047857', dark: '#06231C', bg: '#F7FBFA', text: '#14261F', textMuted: '#4B5D57', cardBg: '#EAF3F0', cardHeaderBg: '#DCEAE5' },
  { id: 'menta-fresca', cat: 'claro', mode: 'light', m1: '#047857', m1a: '#D1FAE5', m2: '#0E7490', m2a: '#CFFAFE', m3: '#6D28D9', m3a: '#EDE9FE', accent: '#0F766E', dark: '#052220', bg: '#F6FBFA', text: '#14231F', textMuted: '#4A5A55', cardBg: '#E9F5F2', cardHeaderBg: '#DBEBE7' },
  { id: 'arena-calida', cat: 'claro', mode: 'light', m1: '#B45309', m1a: '#FEF3C7', m2: '#44403C', m2a: '#F5F5F4', m3: '#0F766E', m3a: '#CCFBF1', accent: '#C2410C', dark: '#1F1710', bg: '#FBF8F3', text: '#2B211A', textMuted: '#6B5D50', cardBg: '#F3ECE1', cardHeaderBg: '#E9DFCF' },
  { id: 'cielo-tech', cat: 'claro', mode: 'light', m1: '#1D4ED8', m1a: '#DBEAFE', m2: '#0E7490', m2a: '#CFFAFE', m3: '#4338CA', m3a: '#E0E7FF', accent: '#0369A1', dark: '#071B2C', bg: '#F5F9FD', text: '#142433', textMuted: '#4B5D6E', cardBg: '#EAF2FA', cardHeaderBg: '#DCE9F5' },
  { id: 'lavanda-suave', cat: 'claro', mode: 'light', m1: '#7E22CE', m1a: '#F3E8FF', m2: '#BE185D', m2a: '#FCE7F3', m3: '#4338CA', m3a: '#E0E7FF', accent: '#6D28D9', dark: '#180F26', bg: '#FAF7FD', text: '#241934', textMuted: '#5C4F6E', cardBg: '#F1EAFA', cardHeaderBg: '#E6DAF5' },
  { id: 'gris-ejecutivo', cat: 'claro', mode: 'light', m1: '#334155', m1a: '#F1F5F9', m2: '#3F3F46', m2a: '#F4F4F5', m3: '#1D4ED8', m3a: '#DBEAFE', accent: '#047857', dark: '#101214', bg: '#F8F9FA', text: '#1E2124', textMuted: '#52575C', cardBg: '#EDEFF1', cardHeaderBg: '#E1E4E7' },
];
