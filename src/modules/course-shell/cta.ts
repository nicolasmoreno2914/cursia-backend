/**
 * Edu EV3 — navegación del estudiante: botones de llamada a la acción (V1 los tenía) que llevan
 * a la siguiente pieza del curso: «Iniciar actividad →», «Presentar evaluación →»,
 * «Continuar con el módulo N →».
 *
 * El shell no conoce los ids de Moodle: escribe un marcador `cursia-cta://…` en el href y el
 * builder (dynamic-mbz-builder-v3) lo reemplaza por el token de restauración real
 * ($@H5PACTIVITYVIEWBYID*mid@$, $@SCORMVIEWBYID*mid@$, $@QUIZVIEWBYID*mid@$,
 * $@COURSESECTIONBYID*n@$) apenas crea la actividad. Un marcador sin resolver falla fuerte.
 */
import type { Hx, Surf } from './html';
import { link } from './html';

export const CTA_ACTIVITY = 'cursia-cta://next-activity';
export const CTA_EXAM = 'cursia-cta://next-exam';
export function ctaSection(sectionNum: number): string {
  if (!Number.isInteger(sectionNum) || sectionNum < 0) throw new Error(`CTA: sección inválida ${sectionNum}`);
  return `cursia-cta://section/${sectionNum}`;
}
/** Cualquier marcador (para el reemplazo y la verificación final). */
export const CTA_RE = /cursia-cta:\/\/(next-activity|next-exam|section\/(\d+))/g;

/** Botón de acción (bloque con fondo de acento; píldora en ENHANCED), separado del texto de arriba. */
export function ctaButton(h: Hx, href: string, text: string, s: Surf): string {
  return link(h, href, text, s, { button: true, margin: '20px 0 0 0' });
}
