/**
 * R9 — `presentation_card`: el label de la presentación de Gamma dentro de un
 * capítulo (audit §D "Gamma inline", §X.1).
 *
 * Fix round 1 (review G5, I4/I7): se arma con las MISMAS primitivas que el
 * Course Shell (course-shell/html.ts, reglas de R2):
 *  - CLEAN_SAFE siempre: fondo sólido hex, texto con contraste verificado
 *    (el enlace usa el acento legible sobre el fondo, nunca moduleColor a
 *    ciegas), tipografía ≥ 16 px (eyebrow = sizeSmallPx del tema);
 *  - ENHANCED (`level: 'enhanced'`) agrega radius / height:auto / display
 *    DESPUÉS de las declaraciones seguras, con el mismo mecanismo aditivo de R2;
 *    sin `level` no se emite nada ENHANCED;
 *  - todo texto va en `<span class="nolink">` (filtros de Moodle, R-005);
 *  - el resultado pasa `lintCleanSafe` de R2 o la función lanza SHELL_RENDER.
 * Nunca se emite un badge "Diapositiva 1 de N" salvo que N venga medido
 * (`slideCount` de pdfPageCount, nunca del LLM).
 */
import type { ResolvedTheme, ModuleColor } from '../../modules/theme-engine';
import { lintCleanSafe } from '../../modules/visual-components';
import {
  ShellRenderOptions,
  box,
  eyebrow,
  hx,
  link,
  pHtml,
  root,
  shellFail,
  st,
  toneSurf,
  unprotectedText,
} from '../../modules/course-shell/html';

export interface PresentationCardInput {
  chapterNumber: number;
  /** Solo informativo: NO se renderiza (el alt es fijo; ver comentario del <img>). */
  chapterTitle: string;
  /** URL/token ya resuelto, típicamente `@@PLUGINFILE@@/.../cap{N}_portada.png`. */
  coverUrl: string;
  /** URL/token ya resuelto hacia el PDF completo. */
  pdfUrl: string;
  /** Conteo real, medido con pdfPageCount — nunca un valor del LLM. */
  slideCount: number;
  theme: ResolvedTheme;
  moduleColor: ModuleColor;
  /** Omitido = solo CLEAN_SAFE. */
  level?: ShellRenderOptions['level'];
}

function assertMeasuredSlideCount(slideCount: number): void {
  if (!Number.isInteger(slideCount) || slideCount < 1) {
    throw new Error(
      `PRESENTATION_CARD_SLIDE_COUNT: slideCount inválido (${slideCount}) — ` +
        'debe venir medido del PDF real, nunca inventado ni <1',
    );
  }
}

function attr(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function presentationCardHtml(input: PresentationCardInput): string {
  const { chapterNumber, coverUrl, pdfUrl, slideCount, theme, moduleColor } = input;
  assertMeasuredSlideCount(slideCount);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) shellFail(`presentation card: chapterNumber inválido (${chapterNumber})`);
  const h = hx(theme, input.level ? { level: input.level } : undefined);
  const cs = toneSurf(h, 'surface');
  // El `alt` es texto FIJO: los filtros de Moodle (emoticon, activitynames) reescriben
  // atributos y `nolink` no protege atributos (verificado con format_text real: un
  // título con ":-)" rompía el <img>). El título del capítulo ya está en el label.
  // HTMLPurifier (forceclean) descarta width/max-width en <img>: el tamaño
  // responsivo va en la capa ENHANCED; la base conserva margin y border.
  const img =
    `<img src="${attr(coverUrl)}" alt="${attr(`Portada de la presentación del capítulo ${chapterNumber}`)}"` +
    st(h, [['margin', '0 0 12px 0'], ['border', `1px solid ${theme.color.border}`]], [['max-width', '100%'], ['width', '100%'], ['height', 'auto'], ['display', 'block']]) +
    ' />';
  const linkText = `Ver presentación completa (PDF, ${slideCount} diapositiva${slideCount === 1 ? '' : 's'})`;
  const inner =
    eyebrow(h, `Presentación — Capítulo ${chapterNumber}`, cs.s) +
    img +
    pHtml(h, link(h, pdfUrl, linkText, cs.s), cs.s, { last: true });
  const html = root(h, `ch${chapterNumber}-presentation`, box(h, inner, cs, { accentLeft: moduleColor.main }));
  const lint = lintCleanSafe(html);
  if (!lint.ok) shellFail(`presentation card: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
  const bare = unprotectedText(html);
  if (bare.length) shellFail(`presentation card: texto sin nolink: ${JSON.stringify(bare.slice(0, 3))}`);
  return html;
}

/**
 * @deprecated Fix round 1 (I4): usar `lintCleanSafe` de R2
 * (modules/visual-components). Se conserva solo por compatibilidad del barrel.
 */
export function lintCleanSafeMinimal(html: string): string[] {
  return lintCleanSafe(html).errors.map((e) => `${e.code}: ${e.message}`);
}
