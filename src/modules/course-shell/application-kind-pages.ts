// r79.1 · Páginas Moodle (mod_page / descripción de la Tarea) de los tipos nuevos de Actividad de Aplicación:
// estudio de caso, proyecto integrador y retroalimentación formativa. Mismo contrato que application-pages.ts:
//   - página del ESTUDIANTE visible, SIN respuestas (el validador del .mbz busca marcas de solucionario en su texto);
//   - SOLUCIONARIO DOCENTE oculto (visible=0) con la guía de cada parte y la guía de corrección por criterio.
// Moodle filtra el HTML (format_text): estilos inline (CLEAN_SAFE), sin <style>/<script>/<details>, texto con nolink.
// Mobile-first (r77): bloques apilados de ancho completo, listas con aire, enlaces/botones de ≥ 44 px (blockLink).
import type { ResolvedTheme } from '../theme-engine';
import { contrastRatio } from '../theme-engine';
import { eduIcon, roleTone, Tone } from '../visual-components/edu';
import { inlineHtml, labelHtml } from '../visual-components/text';
import { Hx, Surf, bgSurf, blockLink, box, eyebrow, heading, hx, link, pHtml, st, toneSurf, ul } from './html';
import { APPLICATION_KIND_LABEL } from '../study-time/application-kind-tiers';
import type { ApplicationKind } from '../study-time/application-kind-tiers';
import type { OutcomeRef } from './application-kinds';

export interface KindPageInput {
  chapterNumber: number;
  chapterTitle: string;
  doc: any;
  pdfFilename: string;
  tone: Tone;
  outcomes?: readonly OutcomeRef[];
  deliveryLines?: string[];
  resources?: Array<{ title: string; instructions: string; href: string; filename: string }>;
}

export function kindStudentPageName(kind: ApplicationKind, chapterNumber: number, title: string): string {
  return `${APPLICATION_KIND_LABEL[kind]} · Capítulo ${chapterNumber}: ${title}`;
}
export function kindSolutionPageName(kind: ApplicationKind, chapterNumber: number): string {
  return `Solucionario docente · ${APPLICATION_KIND_LABEL[kind]} del capítulo ${chapterNumber}`;
}

const LEVEL_LABEL: Readonly<Record<string, string>> = Object.freeze({ comprender: 'Comprender', analizar: 'Analizar', evaluar: 'Evaluar', proponer: 'Proponer' });
const EXHIBIT_LABEL: Readonly<Record<string, string>> = Object.freeze({ table: 'Tabla', data: 'Datos', document: 'Documento', testimony: 'Testimonio' });
const SECTION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  reading: 'Lectura del caso', analysis: 'Análisis', decision: 'Decisión', selfCheck: 'Autoevaluación',
  stages: 'Etapas', integration: 'Integración', study: 'Estudio del ejemplar', review: 'Revisión con criterios', revision: 'Mejora y nueva entrega', peerReview: 'Revisión entre pares', reflection: 'Reflexión',
});

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
function meta(h: Hx, text: string, color0: string, s: Surf): string {
  const color = readable(color0, s);
  return `<p class="cvc-meta"${st(h, [['margin', '0 0 6px 0'], ['padding', 0], ['color', color], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.4']])}>${labelHtml(text)}</p>`;
}
/** Texto largo en párrafos (líneas en blanco = párrafos; saltos simples se conservan como párrafos cortos). */
function paras(h: Hx, text: string, s: Surf, opts: { secondary?: boolean } = {}): string {
  const parts = String(text).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  return parts.map((p) => pHtml(h, inlineHtml(p), s, opts.secondary ? { secondary: true } : {})).join('');
}
function strongLine(h: Hx, label: string, html: string, s: Surf, opts: { secondary?: boolean; last?: boolean } = {}): string {
  return pHtml(h, `<strong>${labelHtml(label)}</strong>${html}`, s, opts);
}
function boxed(h: Hx, title: string, ink: string, inner: (cs: Surf) => string): string {
  const cs = toneSurf(h, 'alt');
  return box(h, eyebrow(h, title, cs.s, { sentence: true, color: readable(ink, cs.s) }) + inner(cs.s), cs);
}

function timePlan(doc: any): string {
  const mbs = doc.activity?.minutesBySection ?? {};
  return Object.keys(mbs).filter((k) => Number(mbs[k]) > 0).map((k) => `${SECTION_LABEL[k] ?? k} ${mbs[k]} min`).join(' · ');
}

/** Bloques comunes de cierre del estudiante: producto, archivos, entrega, autoevaluación, criterios, resultados. */
function studentCommonTail(h: Hx, input: KindPageInput, s: Surf, ink: string, ex: string): string {
  const a = input.doc.activity;
  let body = section(h, 'logro', ink, 'Producto o evidencia', s) +
    pHtml(h, inlineHtml(a.deliverable.description), s) +
    pHtml(h, `<strong>${labelHtml('Formato: ')}</strong>${inlineHtml(a.deliverable.format)}${labelHtml(' · ')}<strong>${labelHtml('Extensión: ')}</strong>${inlineHtml(a.deliverable.extent)}`, s, { secondary: true }) + end;
  if (input.resources && input.resources.length) {
    body += section(h, 'libro', ink, input.resources.length === 1 ? 'Archivo de trabajo' : 'Archivos de trabajo', s) +
      ul(h, input.resources.map((r) => link(h, r.href, `${r.title} (${r.filename}) →`, s, { target: '_blank' }) + (r.instructions.trim() ? `${labelHtml(' — ')}${inlineHtml(r.instructions.trim())}` : '')), s) + end;
  }
  if (input.deliveryLines && input.deliveryLines.length) {
    body += section(h, 'logro', ink, 'Cómo entregar', s) + input.deliveryLines.map((t, i, xs) => pHtml(h, labelHtml(t), s, { last: i === xs.length - 1 })).join('') + end;
  }
  body += section(h, 'check', ex, 'Autoevaluación: revisa tu trabajo', s) + ul(h, a.selfCheck.map((x: string) => `${labelHtml('☐ ')}${inlineHtml(x)}`), s) + end;
  body += section(h, 'objetivo', ink, 'Criterios de evaluación', s) +
    ul(h, a.criteria.map((c: any) => `<strong>${inlineHtml(c.name)}</strong>${labelHtml(` (${c.weight} %) — `)}${inlineHtml(c.description)}`), s) + end;
  const textOf = new Map((input.outcomes ?? []).map((o) => [o.id, o.text]));
  body += section(h, 'objetivo', ink, 'Resultados de aprendizaje que evidencias', s) +
    ul(h, a.outcomeLinks.map((o: any) => {
      const t = textOf.get(o.outcomeId);
      return `<strong>${inlineHtml(t ? (o.outcomeId === 'OBJ' ? t : `${o.outcomeId}: ${t}`) : String(o.outcomeId))}</strong>${labelHtml(' — ')}${inlineHtml(o.evidence)}`;
    }), s) + end;
  return body;
}

/** Página del estudiante de un tipo nuevo (sin respuestas). Devuelve el HTML interno (el llamador lo envuelve y lo valida). */
export function kindStudentBody(input: KindPageInput, theme: ResolvedTheme): { h: Hx; body: string } {
  const doc = input.doc;
  const kind = doc.kind as ApplicationKind;
  const a = doc.activity;
  const h = hx(theme);
  const s = bgSurf(h);
  const ink = input.tone.ink;
  const ex = roleTone(h.t, 'ejemplo').ink;
  let body =
    meta(h, `${APPLICATION_KIND_LABEL[kind]} · Capítulo ${input.chapterNumber} · ~${doc.minutes} min`, ink, s) +
    heading(h, 'h2', a.title, s) +
    pHtml(h, `<strong>${labelHtml('Objetivo: ')}</strong>${inlineHtml(a.objective)}`, s) +
    pHtml(h, `<strong>${labelHtml('Tiempo sugerido: ')}</strong>${labelHtml(timePlan(doc))}`, s, { secondary: true }) +
    blockLink(h, `@@PLUGINFILE@@/${input.pdfFilename}`, 'Descargar para imprimir (PDF) →', s, { target: '_blank', margin: '0 0 16px 0' });
  if (kind === 'case_study') {
    const c = a.case;
    body += section(h, 'caso', ink, 'El caso', s);
    body += boxed(h, `${c.title} · ${c.organization}`, ink, (cs) => paras(h, c.narrative, cs));
    body += end;
    body += section(h, 'visual', ink, c.exhibits.length === 1 ? 'Anexo del caso' : 'Anexos del caso', s);
    c.exhibits.forEach((x: any, i: number) => { body += boxed(h, `Anexo ${i + 1} · ${EXHIBIT_LABEL[x.kind] ?? 'Anexo'}: ${x.title}`, ink, (cs) => paras(h, x.content, cs)); });
    body += end;
    body += section(h, 'practica', ink, 'Preguntas de análisis', s) +
      ul(h, a.questions.map((q: any, i: number) => `<strong>${labelHtml(`Pregunta ${i + 1} · ${LEVEL_LABEL[q.level] ?? q.level}: `)}</strong>${inlineHtml(q.prompt)}`), s, { ordered: false }) + end;
    body += section(h, 'decision', ink, 'Tu decisión', s) + pHtml(h, inlineHtml(a.decision.prompt), s) +
      pHtml(h, `<strong>${labelHtml('Condiciones que debes respetar:')}</strong>`, s, { secondary: true }) + ul(h, a.decision.constraints.map((x: string) => inlineHtml(x)), s) + end;
  } else if (kind === 'integrative_project') {
    body += section(h, 'caso', ink, 'El proyecto', s) + paras(h, a.brief.situation, s) + strongLine(h, 'Producto final: ', inlineHtml(a.brief.finalProduct), s) + end;
    body += section(h, 'proceso', ink, `Etapas del proyecto (${a.stages.length})`, s);
    a.stages.forEach((g: any, i: number) => {
      body += boxed(h, `Etapa ${i + 1} · ~${g.minutes} min · ${g.title}`, ink, (cs) =>
        pHtml(h, inlineHtml(g.purpose), cs) +
        pHtml(h, `<strong>${labelHtml('Se apoya en: ')}</strong>${inlineHtml(g.linkedChapter)}`, cs, { secondary: true }) +
        ul(h, g.tasks.map((x: string) => inlineHtml(x)), cs, { ordered: true }) +
        pHtml(h, `<strong>${labelHtml('Entregable de la etapa: ')}</strong>${inlineHtml(g.intermediateDeliverable)}`, cs, { last: true }));
    });
    body += end;
    body += section(h, 'logro', ink, 'Integración y entrega final', s) + ul(h, a.integration.instructions.map((x: string) => inlineHtml(x)), s, { ordered: true }) +
      strongLine(h, 'Presentación: ', inlineHtml(a.integration.presentation), s, { secondary: true }) + end;
  } else {
    body += section(h, 'repaso', ink, 'Qué vas a revisar', s) + pHtml(h, inlineHtml(a.target.product), s) +
      strongLine(h, 'Viene de: ', inlineHtml(a.target.sourceActivity), s, { secondary: true }) + end;
    body += section(h, 'objetivo', ink, 'Criterios de revisión', s);
    a.reviewCriteria.forEach((r: any, i: number) => {
      body += boxed(h, `Criterio ${i + 1}: ${r.name}`, ink, (cs) => pHtml(h, `<strong>${labelHtml('Qué buscar: ')}</strong>${inlineHtml(r.lookFor)}`, cs) + ul(h, r.questions.map((x: string) => inlineHtml(x)), cs));
    });
    body += end;
    body += section(h, 'ejemplo', ex, 'Ejemplar comentado', s) +
      boxed(h, 'Fragmento sólido', ex, (cs) => paras(h, a.exemplar.strong, cs)) +
      boxed(h, 'Fragmento por mejorar', ink, (cs) => paras(h, a.exemplar.weak, cs)) +
      strongLine(h, 'Por qué uno funciona y el otro no: ', inlineHtml(a.exemplar.commentary), s) + end;
    body += section(h, 'error', ink, 'Errores frecuentes', s) +
      ul(h, a.commonErrors.map((e: any) => `<strong>${inlineHtml(e.error)}</strong>${labelHtml(' — Cómo detectarlo: ')}${inlineHtml(e.howToSpot)}${labelHtml(' · Cómo corregirlo: ')}${inlineHtml(e.howToFix)}`), s) + end;
    if (a.peerReview) {
      body += section(h, 'reflexion', ink, 'Revisión entre pares', s) + pHtml(h, inlineHtml(a.peerReview.protocol), s) + ul(h, a.peerReview.instructions.map((x: string) => inlineHtml(x)), s, { ordered: true }) + end;
    }
    body += section(h, 'proceso', ink, 'Plan de mejora y nueva entrega', s) + ul(h, a.revision.steps.map((x: string) => inlineHtml(x)), s, { ordered: true }) +
      strongLine(h, 'Nueva entrega: ', inlineHtml(a.revision.resubmission), s) + end;
    body += section(h, 'reflexion', ink, 'Reflexión', s) + ul(h, a.reflection.map((x: string) => inlineHtml(x)), s) + end;
  }
  body += studentCommonTail(h, input, s, ink, ex);
  return { h, body };
}

/** Solucionario docente de un tipo nuevo (página oculta). */
export function kindSolutionBody(input: KindPageInput, theme: ResolvedTheme): { h: Hx; body: string } {
  const doc = input.doc;
  const kind = doc.kind as ApplicationKind;
  const a = doc.activity;
  const sol = doc.solution;
  const h = hx(theme);
  const s = bgSurf(h);
  const ink = input.tone.ink;
  const ok = roleTone(h.t, 'ejemplo').ink;
  const warn = roleTone(h.t, 'error').ink;
  let body =
    meta(h, `Solo docentes · Capítulo ${input.chapterNumber}: ${input.chapterTitle}`, warn, s) +
    heading(h, 'h2', `Solucionario: ${a.title}`, s) +
    pHtml(h, labelHtml('Esta página está oculta para los estudiantes. Si la haces visible, los estudiantes verán la guía de corrección.'), s, { secondary: true }) +
    blockLink(h, `@@PLUGINFILE@@/${input.pdfFilename}`, 'Descargar el solucionario (PDF) →', s, { target: '_blank', margin: '0 0 16px 0' });
  if (kind === 'case_study') {
    body += section(h, 'check', ok, 'Análisis esperado de cada pregunta', s);
    sol.questionGuides.forEach((g: any, i: number) => {
      body += boxed(h, `Pregunta ${i + 1}`, ink, (cs) => pHtml(h, inlineHtml(a.questions[i]?.prompt ?? ''), cs, { secondary: true }) + pHtml(h, inlineHtml(g.expectedAnalysis), cs) +
        pHtml(h, `<strong>${labelHtml('Puntos clave:')}</strong>`, cs) + ul(h, g.keyPoints.map((x: string) => inlineHtml(x)), cs));
    });
    body += end;
    body += section(h, 'decision', ink, 'Decisión: discusión para el docente', s) +
      strongLine(h, 'Decisión recomendada: ', inlineHtml(sol.decisionDiscussion.recommended), s) +
      pHtml(h, `<strong>${labelHtml('Alternativas aceptables:')}</strong>`, s) + ul(h, sol.decisionDiscussion.alternatives.map((x: string) => inlineHtml(x)), s) +
      strongLine(h, 'Justificación: ', inlineHtml(sol.decisionDiscussion.justification), s) + end;
    body += section(h, 'reflexion', ink, 'Preguntas para la discusión en clase', s) + ul(h, sol.discussionQuestions.map((x: string) => inlineHtml(x)), s) + end;
  } else if (kind === 'integrative_project') {
    body += section(h, 'proceso', ink, 'Guía de cada etapa', s);
    sol.stageGuides.forEach((g: any, i: number) => {
      body += boxed(h, `Etapa ${i + 1}: ${a.stages[i]?.title ?? ''}`, ink, (cs) =>
        strongLine(h, 'Producto esperado: ', inlineHtml(g.expectedOutput), cs) +
        pHtml(h, `<strong>${labelHtml('Errores frecuentes:')}</strong>`, cs) + ul(h, g.commonErrors.map((x: string) => inlineHtml(x)), cs) +
        pHtml(h, `<strong>${labelHtml('Preguntas de control:')}</strong>`, cs) + ul(h, g.checkpointQuestions.map((x: string) => inlineHtml(x)), cs));
    });
    body += end;
    body += section(h, 'logro', ink, 'Ejemplo de producto final', s) + paras(h, sol.finalProductExemplar, s) + end;
  } else {
    body += section(h, 'reflexion', ink, 'Banco de retroalimentación por criterio de revisión', s);
    sol.feedbackBank.forEach((g: any) => {
      body += boxed(h, g.criterion, ink, (cs) =>
        strongLine(h, 'Logrado: ', inlineHtml(g.achieved), cs) + strongLine(h, 'En proceso: ', inlineHtml(g.developing), cs) + strongLine(h, 'Insuficiente: ', inlineHtml(g.insufficient), cs) +
        strongLine(h, 'Comentario sugerido: ', inlineHtml(g.feedbackComment), cs) + strongLine(h, 'Siguiente paso: ', inlineHtml(g.nextStep), cs, { last: true }));
    });
    body += end;
    body += section(h, 'error', ink, 'Diagnóstico de errores', s) + ul(h, sol.errorGuide.map((e: any) => `<strong>${inlineHtml(e.error)}</strong>${labelHtml(' — ')}${inlineHtml(e.diagnosis)}`), s) + end;
  }
  body += section(h, 'objetivo', ink, 'Guía de corrección por criterio', s);
  for (const g of sol.correctionGuide) {
    const c = a.criteria.find((x: any) => String(x.name).trim() === String(g.criterion).trim());
    body += boxed(h, `${g.criterion}${c ? ` · ${c.weight} %` : ''}`, ink, (cs) =>
      strongLine(h, 'Logrado: ', inlineHtml(g.achieved), cs) + strongLine(h, 'En proceso: ', inlineHtml(g.developing), cs) + strongLine(h, 'Insuficiente: ', inlineHtml(g.insufficient), cs, { last: true }));
  }
  body += end;
  body += section(h, 'reflexion', ink, 'Observaciones para el docente', s) + ul(h, sol.teacherNotes.map((x: string) => inlineHtml(x)), s) + end;
  return { h, body };
}
