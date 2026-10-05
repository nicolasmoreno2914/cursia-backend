// Fase 2 · Actividades de Aplicación — páginas Moodle (mod_page) del documento `dynamic_application_json`.
//
//   - Página del ESTUDIANTE (visible): objetivo, contexto, ejemplos resueltos, ejercicios graduados, taller,
//     producto/evidencia, autoevaluación y criterios — y el enlace al PDF imprimible (mismo JSON, renglones para
//     responder en papel). NUNCA lleva respuestas: las respuestas viven solo en el solucionario.
//   - SOLUCIONARIO DOCENTE (página oculta, visible=0): respuestas + explicación por ejercicio, solución esperada del
//     taller, guía de corrección por criterio (logrado / en proceso / insuficiente; base de una rúbrica futura) y
//     observaciones. Moodle no deja abrir una actividad oculta a un estudiante (moodle/course:viewhiddenactivities).
//
// Moodle filtra el HTML (format_text): todo va con estilos inline (CLEAN_SAFE), sin <style>/<script>/<details>, y
// el texto protegido con nolink. Falla fuerte (shellFail) ante un documento que no cumple.
import type { ResolvedTheme } from '../theme-engine';
import { contrastRatio } from '../theme-engine';
import { lintCleanSafe } from '../visual-components';
import { eduIcon, roleTone, Tone } from '../visual-components/edu';
import { inlineHtml, labelHtml } from '../visual-components/text';
import { Hx, Surf, bgSurf, box, eyebrow, heading, hx, link, pHtml, root, shellFail, st, toneSurf, ul, unprotectedText } from './html';
import { validateApplicationActivityDoc } from './application-activity';

export interface ApplicationPageInput {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** Documento validado (`dynamic_application_json`). */
  doc: any;
  /** Nombre del PDF adjunto a la página (en su filearea; el enlace usa @@PLUGINFILE@@). */
  pdfFilename: string;
  tone: Tone;
}

export interface ApplicationPage {
  name: string;
  html: string;
}

const DIFFICULTY_LABEL: Readonly<Record<string, string>> = Object.freeze({ basico: 'Básico', intermedio: 'Intermedio', avanzado: 'Avanzado' });
export const APPLICATION_GENRE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  calculation: 'Resolución de problemas',
  case_analysis: 'Análisis de casos',
  procedure: 'Procedimiento',
  production: 'Producción',
  design_build: 'Diseño y construcción',
  decision: 'Toma de decisiones',
  inquiry: 'Indagación',
});

export function applicationStudentPageName(chapterNumber: number, title: string): string {
  return `Actividad de Aplicación · Capítulo ${chapterNumber}: ${title}`;
}
export function applicationSolutionPageName(chapterNumber: number): string {
  return `Solucionario docente · Actividad de Aplicación del capítulo ${chapterNumber}`;
}

function assertDoc(input: ApplicationPageInput): void {
  const errs = validateApplicationActivityDoc(input.doc, { chapterId: input.chapterId, minutes: input.doc?.minutes });
  if (errs.length) shellFail(`Actividad de Aplicación del capítulo ${input.chapterNumber}: documento inválido (${errs.slice(0, 3).map((e) => `${e.code} ${e.path}`).join('; ')})`);
}

function finish(name: string, uid: string, h: Hx, inner: string): ApplicationPage {
  const html = root(h, uid, inner);
  if (/<(style|script|details)\b/i.test(html)) shellFail(`${name}: la página lleva <style>/<script>/<details>`);
  const lint = lintCleanSafe(html);
  if (!lint.ok) shellFail(`${name}: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
  const unprotected = unprotectedText(html);
  if (unprotected.length > 0) shellFail(`${name}: texto sin protección nolink: ${JSON.stringify(unprotected.slice(0, 3))}`);
  return { name, html };
}

/** Color de texto legible sobre el fondo (AA 4,5:1); si el del rol no alcanza, el del texto. */
function readable(color: string, s: Surf): string {
  try {
    return contrastRatio(color, s.bg) >= 4.5 ? color : s.fg;
  } catch {
    return s.fg;
  }
}

function section(h: Hx, icon: Parameters<typeof eduIcon>[1], color0: string, title: string, s: Surf): string {
  const color = readable(color0, s);
  return `<div${st(h, [['margin', '28px 0 0 0'], ['padding', 0], ['color', s.fg]])}>` + `<p${st(h, [['margin', '0 0 10px 0'], ['color', color], ['font-weight', '700'], ['font-size', h.t.typography.sizeBodyPx]])}>${eduIcon(h.enh, icon, color, 20)} ${labelHtml(title)}</p>`;
}
const end = '</div>';

function meta(h: Hx, text: string, color0: string, s?: Surf): string {
  const color = s ? readable(color0, s) : color0;
  return `<p class="cvc-meta"${st(h, [['margin', '0 0 6px 0'], ['padding', 0], ['color', color], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.4']])}>${labelHtml(text)}</p>`;
}

/** Página del estudiante (sin respuestas). */
export function applicationStudentPage(input: ApplicationPageInput, theme: ResolvedTheme): ApplicationPage {
  assertDoc(input);
  const a = input.doc.activity;
  const h = hx(theme); // CLEAN_SAFE: la página nunca lleva <style>.
  const s = bgSurf(h);
  const ink = input.tone.ink;
  const ex = roleTone(h.t, 'ejemplo').ink;
  const name = applicationStudentPageName(input.chapterNumber, input.chapterTitle);
  const minutes = input.doc.minutes as number;
  let body =
    meta(h, `Actividad de Aplicación · Capítulo ${input.chapterNumber} · ${APPLICATION_GENRE_LABEL[a.genre] ?? 'Aplicación'} · ~${minutes} min`, ink, s) +
    heading(h, 'h2', a.title, s) +
    pHtml(h, `<strong>${labelHtml('Objetivo: ')}</strong>${inlineHtml(a.objective)}`, s) +
    pHtml(h, inlineHtml(a.context), s, { secondary: true }) +
    link(h, `@@PLUGINFILE@@/${input.pdfFilename}`, 'Descargar para imprimir (PDF) →', s, { target: '_blank' });
  if (a.examples.length) {
    body += section(h, 'ejemplo', ex, a.examples.length === 1 ? 'Ejemplo resuelto' : 'Ejemplos resueltos', s);
    for (const e of a.examples) {
      const cs = toneSurf(h, 'alt');
      body += box(
        h,
        eyebrow(h, e.title, cs.s, { sentence: true, color: readable(ex, cs.s) }) +
          pHtml(h, inlineHtml(e.problem), cs.s) +
          ul(h, e.steps.map((x: string) => inlineHtml(x)), cs.s, { ordered: true }) +
          pHtml(h, `<strong>${labelHtml('Resultado: ')}</strong>${inlineHtml(e.result)}`, cs.s, { last: true }),
        cs,
      );
    }
    body += end;
  }
  body += section(h, 'practica', ink, 'Ejercicios', s);
  body += `<ol class="cvc-app-exercises"${st(h, [['list-style', 'none'], ['margin', '0 0 8px 0'], ['padding', 0]])}>` +
    a.exercises
      .map((e: any, i: number) =>
        `<li${st(h, [['margin', 0], ['padding', '14px 0'], ['color', s.fg], ['border-top', `1px solid ${h.t.color.border}`]])}>` +
        meta(h, `Ejercicio ${i + 1} · ${DIFFICULTY_LABEL[e.difficulty] ?? e.difficulty}`, ink, s) +
        pHtml(h, inlineHtml(e.prompt), s, { last: true }) +
        `</li>`,
      )
      .join('') +
    `</ol>` + end;
  body += section(h, 'caso', ink, 'Taller de aplicación', s);
  {
    const cs = toneSurf(h, 'alt');
    body += box(h, eyebrow(h, a.workshop.title, cs.s, { sentence: true, color: readable(ink, cs.s) }) + pHtml(h, inlineHtml(a.workshop.situation), cs.s) + ul(h, a.workshop.instructions.map((x: string) => inlineHtml(x)), cs.s, { ordered: true }), cs);
  }
  body += end;
  body += section(h, 'logro', ink, 'Producto o evidencia', s) +
    pHtml(h, inlineHtml(a.deliverable.description), s) +
    pHtml(h, `<strong>${labelHtml('Formato: ')}</strong>${inlineHtml(a.deliverable.format)}${labelHtml(' · ')}<strong>${labelHtml('Extensión: ')}</strong>${inlineHtml(a.deliverable.extent)}`, s, { secondary: true }) + end;
  body += section(h, 'check', ex, 'Autoevaluación: revisa tu trabajo', s) + ul(h, a.selfCheck.map((x: string) => `${labelHtml('☐ ')}${inlineHtml(x)}`), s) + end;
  body += section(h, 'objetivo', ink, 'Criterios de evaluación', s) +
    ul(h, a.criteria.map((c: any) => `<strong>${inlineHtml(c.name)}</strong>${labelHtml(` (${c.weight} %) — `)}${inlineHtml(c.description)}`), s) + end;
  return finish(name, `application-ch${input.chapterNumber}`, h, body);
}

/** Solucionario docente (página oculta). */
export function applicationSolutionPage(input: ApplicationPageInput, theme: ResolvedTheme): ApplicationPage {
  assertDoc(input);
  const a = input.doc.activity;
  const sol = input.doc.solution;
  const h = hx(theme);
  const s = bgSurf(h);
  const ink = input.tone.ink;
  const ok = roleTone(h.t, 'ejemplo').ink;
  const warn = roleTone(h.t, 'error').ink;
  const name = applicationSolutionPageName(input.chapterNumber);
  let body =
    meta(h, `Solo docentes · Capítulo ${input.chapterNumber}: ${input.chapterTitle}`, warn, s) +
    heading(h, 'h2', `Solucionario: ${a.title}`, s) +
    pHtml(h, labelHtml('Esta página está oculta para los estudiantes. Si la haces visible, los estudiantes verán las respuestas.'), s, { secondary: true }) +
    link(h, `@@PLUGINFILE@@/${input.pdfFilename}`, 'Descargar el solucionario (PDF) →', s, { target: '_blank' });
  body += section(h, 'check', ok, 'Respuestas de los ejercicios', s);
  body += `<ol${st(h, [['list-style', 'none'], ['margin', '0 0 8px 0'], ['padding', 0]])}>` +
    sol.answers
      .map((x: any, i: number) =>
        `<li${st(h, [['margin', 0], ['padding', '14px 0'], ['color', s.fg], ['border-top', `1px solid ${h.t.color.border}`]])}>` +
        meta(h, `Ejercicio ${i + 1}`, ink, s) +
        pHtml(h, inlineHtml(a.exercises[i].prompt), s, { secondary: true }) +
        pHtml(h, `<strong>${labelHtml('Respuesta: ')}</strong>${inlineHtml(x.answer)}`, s) +
        pHtml(h, `<strong>${labelHtml('Por qué: ')}</strong>${inlineHtml(x.explanation)}`, s, { last: true }) +
        `</li>`,
      )
      .join('') +
    `</ol>` + end;
  body += section(h, 'caso', ink, 'Solución esperada del taller', s) + pHtml(h, inlineHtml(sol.workshopSolution), s) + end;
  body += section(h, 'objetivo', ink, 'Guía de corrección por criterio', s);
  for (const [i, g] of sol.correctionGuide.entries()) {
    const c = a.criteria[i];
    const cs = toneSurf(h, 'alt');
    body += box(
      h,
      eyebrow(h, `${g.criterion} · ${c.weight} %`, cs.s, { sentence: true, color: readable(ink, cs.s) }) +
        pHtml(h, `<strong>${labelHtml('Logrado: ')}</strong>${inlineHtml(g.achieved)}`, cs.s) +
        pHtml(h, `<strong>${labelHtml('En proceso: ')}</strong>${inlineHtml(g.developing)}`, cs.s) +
        pHtml(h, `<strong>${labelHtml('Insuficiente: ')}</strong>${inlineHtml(g.insufficient)}`, cs.s, { last: true }),
      cs,
    );
  }
  body += end;
  body += section(h, 'reflexion', ink, 'Observaciones para el docente', s) + ul(h, sol.teacherNotes.map((x: string) => inlineHtml(x)), s) + end;
  return finish(name, `application-solution-ch${input.chapterNumber}`, h, body);
}
