/**
 * P3 — Sistema visual educativo 2.0: íconos, tonos por rol y tono de módulo.
 *
 * Íconos: 18 trazos SVG 24×24 (línea 2 px, sin relleno) SOLO en ENHANCED (aria-hidden, sin texto);
 * en CLEAN_SAFE el mismo ícono es un glifo Unicode monocromo (nunca emoji: sin VS16, fuera de
 * los rangos que iOS/Android pintan a color) dentro del mismo <span> con color del tono.
 * Ningún texto queda oculto en ningún nivel: el glifo solo existe en CLEAN y el SVG solo en ENHANCED.
 */
import { contrastRatio, EduBlockRole, ModuleColor, ON_DARK, ResolvedTheme } from '../theme-engine';
import { hexToHsl, hslToHex } from '../theme-engine/color-math';

export type EduIcon =
  | 'concepto'
  | 'ejemplo'
  | 'caso'
  | 'error'
  | 'proceso'
  | 'decision'
  | 'reflexion'
  | 'visual'
  | 'video'
  | 'practica'
  | 'examen'
  | 'reloj'
  | 'check'
  | 'flecha'
  | 'logro'
  | 'libro'
  | 'objetivo'
  | 'repaso'
  | 'presentacion';

export const EDU_ICONS: Record<EduIcon, { d: string; glyph: string }> = {
  concepto: { d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z', glyph: '✦' },
  ejemplo: { d: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM8 12.5l2.7 2.7L16 9.5', glyph: '✓' },
  caso: { d: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16', glyph: '▣' },
  error: { d: 'M12 4L2.5 20h19zM12 10v4M12 17v.5', glyph: '✕' },
  proceso: { d: 'M3 18h5v-5h5V8h5V4', glyph: '⇢' },
  decision: { d: 'M12 21v-7M12 14L6 8V3M12 14l6-6V3', glyph: '⋔' },
  reflexion: { d: 'M5 5h14v10H10l-5 4z', glyph: '❝' },
  visual: { d: 'M4 4h7v7H4zM13 13h7v7h-7zM11 7.5h5.5V13', glyph: '▦' },
  video: { d: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM10 8.5v7l6-3.5z', glyph: '►' },
  practica: { d: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3', glyph: '✎' },
  examen: { d: 'M9 3h6v3H9zM7 4.5H5V21h14V4.5h-2M9 14l2 2 4-4', glyph: '☰' },
  reloj: { d: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 7.5V12l3 2', glyph: '◷' },
  check: { d: 'M5 12.5l4.5 4.5L19 7', glyph: '✓' },
  flecha: { d: 'M5 12h14M13 6l6 6-6 6', glyph: '→' },
  logro: { d: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8', glyph: '★' },
  libro: { d: 'M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z', glyph: '▥' },
  objetivo: { d: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 0 0 0-9zM12 11.2v1.6', glyph: '◎' },
  repaso: { d: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 16.8v.4', glyph: '?' },
  presentacion: { d: 'M3 4h18v12H3zM8 20l4-4 4 4', glyph: '▭' },
};

/** Ícono: SVG (ENHANCED) o glifo (CLEAN). `px` = lado del SVG. */
export function eduIcon(enh: boolean, id: EduIcon, color: string, px = 20): string {
  const ic = EDU_ICONS[id];
  if (enh) {
    return (
      `<svg class="cvc-ic" viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true" focusable="false">` +
      `<path d="${ic.d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    );
  }
  return `<span class="cvc-glyph" style="color:${color};font-weight:700"><span class="nolink">${ic.glyph}</span></span>`;
}

/** Tono resuelto de un bloque (rol pedagógico o módulo). */
export interface Tone {
  ink: string;
  soft: string;
  edge: string;
  fill: string;
  onFill: string;
}

export function roleTone(t: ResolvedTheme, role: EduBlockRole): Tone {
  const b = t.blocks[role];
  return { ink: b.ink, soft: b.soft, edge: b.edge, fill: b.ink, onFill: b.onInk };
}

/**
 * Tono del módulo: insignia rellena = moduleColor.main/onMain; ink legible sobre soft y sobre el
 * fondo del label (en oscuro el main suele ser profundo: se aclara manteniendo el tono).
 */
export function moduleTone(t: ResolvedTheme, mc: ModuleColor, ground: string): Tone {
  const { h, s } = hexToHsl(mc.main);
  const dark = t.mode === 'dark';
  const soft = dark ? hslToHex(h, Math.min(s, 0.4), 0.17) : mc.soft;
  const cands = [mc.main, ...[0.3, 0.26, 0.22, 0.72, 0.78, 0.84].map((l) => hslToHex(h, Math.min(Math.max(s, 0.35), 0.7), l))];
  const ink = cands.find((c) => contrastRatio(c, soft) >= 4.5 && contrastRatio(c, ground) >= 4.5);
  if (!ink) throw new Error(`VC_RENDER: el color de módulo ${mc.main} no da un tono legible sobre ${soft} y ${ground}`);
  const edge = dark ? hslToHex(h, Math.min(s, 0.45), 0.32) : hslToHex(h, Math.min(s, 0.45), 0.8);
  // En oscuro el main del módulo suele ser profundo (se perdería sobre la lámina): la insignia y el
  // botón se rellenan con el ink claro y texto oscuro.
  if (dark) {
    const on = [ON_DARK, t.color.bg].find((c) => contrastRatio(c, ink) >= 4.5);
    if (!on) throw new Error(`VC_RENDER: sin texto legible sobre el relleno del módulo ${ink}`);
    return { ink, soft, edge, fill: ink, onFill: on };
  }
  const fillOk = contrastRatio(mc.onMain, mc.main) >= 4.5;
  return { ink, soft, edge, fill: fillOk ? mc.main : ink, onFill: fillOk ? mc.onMain : soft };
}
