// Loop 9 B · «Práctica guiada» — página Moodle (mod_page) del documento `dynamic_guided_practice_json`.
//
// Una página VISIBLE en la sección del capítulo, justo después del texto del capítulo (antes del video interactivo y de
// la actividad): por ejercicio, título y minutos, situación, consignas (lista numerada), producto esperado, criterios
// de autoevaluación y, al final, «Respuesta modelo (revísala después de intentarlo)». Formativa y sin nota: no tiene
// solucionario oculto ni pesos (no es una Actividad de Aplicación).
//
// Moodle filtra el HTML (format_text): todo va con estilos inline (CLEAN_SAFE), sin <style>/<script>/<details>, y el
// texto protegido con nolink. Falla fuerte (shellFail) ante un documento que no cumple.
import type { ResolvedTheme } from '../theme-engine';
import { contrastRatio } from '../theme-engine';
import { lintCleanSafe } from '../visual-components';
import { eduIcon, roleTone, Tone } from '../visual-components/edu';
import { inlineHtml, labelHtml } from '../visual-components/text';
import { Hx, Surf, bgSurf, box, eyebrow, heading, hx, pHtml, root, shellFail, st, toneSurf, ul, unprotectedText } from './html';
import { validateGuidedPracticeDoc } from './guided-practice';

export interface GuidedPracticePageInput {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** Documento validado (`dynamic_guided_practice_json`). */
  doc: any;
  tone: Tone;
}

export interface GuidedPracticePage {
  name: string;
  html: string;
}

export const GUIDED_PRACTICE_KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  case_analysis: 'Análisis de caso',
  worked_problem: 'Problema guiado',
  decision_analysis: 'Análisis de decisión',
});

/** Título de la página: «Ejercicios guiados — <título del capítulo>» (fix round 1, I4: el nombre visible; el tipo interno sigue siendo guided_practice). */
export function guidedPracticePageName(chapterTitle: string): string {
  return `Ejercicios guiados — ${chapterTitle}`;
}

/** Texto del bloque de la respuesta modelo (página y Libro Guía). */
export const GUIDED_PRACTICE_MODEL_ANSWER_TITLE = 'Respuesta modelo (revísala después de intentarlo)';

function readable(color: string, s: Surf): string {
  try {
    return contrastRatio(color, s.bg) >= 4.5 ? color : s.fg;
  } catch {
    return s.fg;
  }
}

function meta(h: Hx, text: string, color0: string, s: Surf): string {
  const color = readable(color0, s);
  return `<p class="cvc-meta"${st(h, [['margin', '0 0 6px 0'], ['padding', 0], ['color', color], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.4']])}>${labelHtml(text)}</p>`;
}

function sub(h: Hx, icon: Parameters<typeof eduIcon>[1], color0: string, title: string, s: Surf): string {
  const color = readable(color0, s);
  return `<p${st(h, [['margin', '14px 0 6px 0'], ['color', color], ['font-weight', '700'], ['font-size', h.t.typography.sizeBodyPx]])}>${eduIcon(h.enh, icon, color, 18)} ${labelHtml(title)}</p>`;
}

/** Párrafos de un texto largo (la respuesta modelo puede traer saltos de línea). */
function paragraphsHtml(h: Hx, text: string, s: Surf): string {
  const parts = String(text).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  return parts.map((p, i) => pHtml(h, inlineHtml(p), s, i === parts.length - 1 ? { last: true } : {})).join('');
}

export function guidedPracticePage(input: GuidedPracticePageInput, theme: ResolvedTheme): GuidedPracticePage {
  const errs = validateGuidedPracticeDoc(input.doc, { chapterId: input.chapterId, minutes: input.doc?.minutes });
  if (errs.length) shellFail(`Ejercicios guiados del capítulo ${input.chapterNumber}: documento inválido (${errs.slice(0, 3).map((e) => `${e.code} ${e.path}`).join('; ')})`);
  const doc = input.doc;
  const h = hx(theme); // CLEAN_SAFE: la página nunca lleva <style>.
  const s = bgSurf(h);
  const ink = input.tone.ink;
  const ex = roleTone(h.t, 'ejemplo').ink;
  const name = guidedPracticePageName(input.chapterTitle);
  const n = doc.exercises.length;
  let body =
    meta(h, `Ejercicios guiados · Capítulo ${input.chapterNumber} · ${n} ejercicios · ~${doc.minutes} min`, ink, s) +
    heading(h, 'h2', name, s) +
    pHtml(h, labelHtml('Ejercicios formativos: no tienen nota. Resuelve cada ejercicio con lo que aprendiste en este capítulo y después compara tu trabajo con la respuesta modelo.'), s, { secondary: true });
  for (const [i, e] of (doc.exercises as any[]).entries()) {
    body += `<div${st(h, [['margin', '28px 0 0 0'], ['padding', '18px 0 0 0'], ['color', s.fg], ['border-top', `1px solid ${h.t.color.border}`]])}>`;
    body += meta(h, `Ejercicio ${i + 1} de ${n} · ${GUIDED_PRACTICE_KIND_LABEL[e.kind] ?? 'Práctica'} · ~${e.minutes} min`, ink, s);
    body += heading(h, 'h3', e.title, s);
    body += sub(h, 'caso', ink, 'Situación', s) + paragraphsHtml(h, e.situation, s);
    body += sub(h, 'practica', ink, 'Qué debes hacer', s) + ul(h, e.tasks.map((t: string) => inlineHtml(t)), s, { ordered: true });
    body += sub(h, 'logro', ink, 'Producto esperado', s) + pHtml(h, inlineHtml(e.expectedProduct), s);
    body += sub(h, 'check', ex, 'Criterios para revisar tu trabajo', s) +
      ul(h, e.criteria.map((c: any) => `<strong>${inlineHtml(c.name)}</strong>${labelHtml(' — ')}${inlineHtml(c.descriptor)}`), s);
    const cs = toneSurf(h, 'alt');
    body += box(h, eyebrow(h, GUIDED_PRACTICE_MODEL_ANSWER_TITLE, cs.s, { sentence: true, color: readable(ex, cs.s) }) + paragraphsHtml(h, e.modelAnswer, cs.s), cs);
    body += '</div>';
  }
  const html = root(h, `guided-practice-ch${input.chapterNumber}`, body);
  if (/<(style|script|details)\b/i.test(html)) shellFail(`${name}: la página lleva <style>/<script>/<details>`);
  const lint = lintCleanSafe(html);
  if (!lint.ok) shellFail(`${name}: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((x) => `${x.code} ${x.message}`).join('; ')}`);
  const unprotected = unprotectedText(html);
  if (unprotected.length > 0) shellFail(`${name}: texto sin protección nolink: ${JSON.stringify(unprotected.slice(0, 3))}`);
  return { name, html };
}

/**
 * Loop 9 B · la misma práctica guiada al final del capítulo en el Libro Guía (Markdown que el Libro renderiza). No cuenta
 * en las palabras del Libro (sus minutos son los de la práctica guiada: el Libro solo la reproduce).
 */
export function guidedPracticeLibroMarkdown(doc: any): string {
  const out: string[] = ['## Ejercicios guiados del capítulo', '', `Ejercicios formativos (sin nota): ${doc.exercises.length} ejercicios, unos ${doc.minutes} minutos en total. Intenta cada ejercicio antes de leer la respuesta modelo.`, ''];
  for (const [i, e] of (doc.exercises as any[]).entries()) {
    out.push(`### Ejercicio ${i + 1}. ${e.title} (~${e.minutes} min)`, '');
    out.push('**Situación.**', '', ...String(e.situation).split(/\n+/).map((x) => x.trim()).filter(Boolean).flatMap((x) => [x, '']));
    out.push('**Qué debes hacer.**', '', ...e.tasks.map((t: string, k: number) => `${k + 1}. ${t}`), '');
    out.push(`**Producto esperado.** ${e.expectedProduct}`, '');
    out.push('**Criterios para revisar tu trabajo.**', '', ...e.criteria.map((c: any) => `- **${c.name}**: ${c.descriptor}`), '');
    out.push(`**${GUIDED_PRACTICE_MODEL_ANSWER_TITLE}.**`, '', ...String(e.modelAnswer).split(/\n+/).map((x) => x.trim()).filter(Boolean).flatMap((x) => [x, '']));
  }
  return out.join('\n').trim() + '\n';
}
