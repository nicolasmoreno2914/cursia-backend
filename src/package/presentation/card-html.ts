/**
 * R9 — `presentation_card`: el label CLEAN_SAFE + ENHANCED de la
 * presentación de Gamma dentro de un capítulo (ver audit §D "Gamma inline"
 * y §X.1 "Reglas de renderer").
 *
 * CLEAN_SAFE primero, ENHANCED después:
 *  - Todo lo que Moodle necesita para que la tarjeta sea legible con
 *    `forceclean=1` (fondo sólido hex, borde, tipografía, imagen
 *    `max-width:100%`+`width:100%` con `alt`, y el link de respaldo al PDF)
 *    va primero en cada atributo `style`.
 *  - Lo que solo mejora la experiencia con CSS completo (radius, shadow,
 *    `height:auto` — no está en la whitelist de forceclean pero tampoco
 *    rompe nada si se cae) se agrega DESPUÉS, en el mismo atributo, nunca
 *    reemplazando ni reordenando lo anterior.
 *  - Nunca se emite un badge "Diapositiva 1 de N" salvo que N venga medido
 *    (parámetro `slideCount`, nunca un número inventado por el LLM).
 */
import { esc } from '../mbz-common';
import type { ResolvedTheme, ModuleColor } from '../../modules/theme-engine';

export interface PresentationCardInput {
  chapterNumber: number;
  chapterTitle: string;
  /** URL/token ya resuelto, típicamente `@@PLUGINFILE@@/.../cap{N}_portada.png`. */
  coverUrl: string;
  /** URL/token ya resuelto hacia el PDF completo. */
  pdfUrl: string;
  /** Conteo real, medido con pdfPageCount — nunca un valor del LLM. */
  slideCount: number;
  theme: ResolvedTheme;
  moduleColor: ModuleColor;
}

function assertMeasuredSlideCount(slideCount: number): void {
  if (!Number.isInteger(slideCount) || slideCount < 1) {
    throw new Error(
      `PRESENTATION_CARD_SLIDE_COUNT: slideCount inválido (${slideCount}) — ` +
        'debe venir medido del PDF real, nunca inventado ni <1',
    );
  }
}

export function presentationCardHtml(input: PresentationCardInput): string {
  const { chapterNumber, chapterTitle, coverUrl, pdfUrl, slideCount, theme, moduleColor } = input;
  assertMeasuredSlideCount(slideCount);

  const c = theme.color;
  const shape = theme.shape;
  const title = esc(chapterTitle);

  // Contenedor: fondo sólido + borde + espaciado (CLEAN_SAFE) y luego
  // radius + shadow sutil (ENHANCED, se cae solo con forceclean=1).
  const containerSafeStyle =
    `background-color:${c.surface};` +
    `border:1px solid ${c.border};` +
    `margin:16px 0;` +
    `padding:16px;`;
  const containerEnhancedStyle = `border-radius:${shape.radiusMd}px;box-shadow:0 1px 3px rgba(0,0,0,0.12);`;

  const eyebrowStyle = `color:${c.textSecondary};font-size:13px;margin:0 0 8px 0;font-weight:${theme.typography.weightBody};`;

  // Imagen: CLEAN_SAFE = max-width/width (ambos sobreviven a forceclean=1,
  // "height" NO está en la whitelist de forceclean así que va solo en la
  // parte ENHANCED — sin él el navegador igual mantiene la proporción).
  const imgSafeStyle = `max-width:100%;width:100%;margin:0 0 12px 0;border:1px solid ${c.border};`;
  const imgEnhancedStyle = `height:auto;display:block;`;

  const linkSafeStyle = `color:${moduleColor.main};font-weight:700;`;
  const linkText = `Ver presentación completa (PDF, ${slideCount} diapositiva${slideCount === 1 ? '' : 's'})`;

  const linkParagraphSafeStyle = `margin:0;color:${c.textPrimary};font-size:${theme.typography.sizeBodyPx}px;`;

  return (
    `<div style="${containerSafeStyle}${containerEnhancedStyle}">` +
    `<p style="${eyebrowStyle}">Presentación — Capítulo ${chapterNumber}</p>` +
    `<img src="${esc(coverUrl)}" alt="${title}" style="${imgSafeStyle}${imgEnhancedStyle}" />` +
    `<p style="${linkParagraphSafeStyle}">` +
    `<a href="${esc(pdfUrl)}" style="${linkSafeStyle}">${esc(linkText)}</a>` +
    `</p>` +
    `</div>`
  );
}

/**
 * Lint mínimo local (equivalente reducido al `lintCleanSafe` de R2, que
 * todavía no está en esta rama — ver r9-core-gamma.md punto de tests).
 * No reemplaza al lint real de R2; solo cubre lo que este módulo necesita
 * garantizar por sí mismo:
 *   1. todos los colores usados en `style="..."` son hex (#RGB o #RRGGBB);
 *   2. el elemento raíz tiene `background-color` hex sólido;
 *   3. no hay `display:none` en ningún lado.
 */
export function lintCleanSafeMinimal(html: string): string[] {
  const violations: string[] = [];

  const styleAttrs = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
  const colorDeclRe = /(?:^|;)\s*(color|background-color|border-color)\s*:\s*([^;]+)/g;
  const hexRe = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  for (const style of styleAttrs) {
    let m: RegExpExecArray | null;
    while ((m = colorDeclRe.exec(style))) {
      const value = m[2].trim();
      if (!hexRe.test(value)) {
        violations.push(`color no-hex en "${m[1]}: ${value}"`);
      }
    }
  }

  const rootStyleMatch = html.match(/^<div style="([^"]*)"/);
  if (!rootStyleMatch || !/background-color\s*:\s*#/.test(rootStyleMatch[1])) {
    violations.push('el elemento raíz no tiene background-color hex sólido');
  }

  if (/display\s*:\s*none/i.test(html)) {
    violations.push('contiene display:none');
  }

  return violations;
}
