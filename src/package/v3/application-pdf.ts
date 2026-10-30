// Fase 2 · Actividades de Aplicación — PDF imprimible (pdfkit), generado del MISMO documento que la página HTML:
//   - estudiante: la actividad con renglones para responder cada ejercicio en papel (answerLines) y espacio para el
//     taller; SIN respuestas;
//   - docente: el solucionario (respuestas, solución del taller, guía de corrección, observaciones).
// Fuentes estándar (WinAnsi) con la misma transliteración del Libro Guía (`pdfText`); fecha fija → bytes estables.
import PDFDocument = require('pdfkit');
import type { ResolvedTheme } from '../../modules/theme-engine';
import { contrastRatio } from '../../modules/theme-engine';
import { APPLICATION_GENRE_LABEL } from '../../modules/course-shell/application-pages';
import { criterionForGuide } from '../../modules/course-shell/application-activity';
import { applicationDocKind } from '../../modules/course-shell/application-pages';
import { APPLICATION_KIND_LABEL } from '../../modules/study-time/application-kind-tiers';
import type { OutcomeRef } from '../../modules/course-shell/application-kinds';
import { LIBRO_PDF_FIXED_DATE, pdfText, unmappedCharCount } from './libro-v3';

export interface ApplicationPdfInput {
  courseTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  doc: any;
  theme: ResolvedTheme;
  /** Clave determinística del documento (sha del artifact): va en /Keywords. */
  documentKey?: string;
  /** r79.1: resultados del capítulo (texto de los que cita un tipo nuevo). */
  outcomes?: readonly OutcomeRef[];
}

export interface ApplicationPdfResult {
  pdf: Buffer;
  pages: number;
  /** Caracteres visibles sin equivalente en las fuentes del PDF (se informan; nunca se pintan como basura). */
  unmappedChars: number;
}

const PAGE = { w: 612, h: 792, top: 64, bottom: 64, left: 64, right: 64 };
const INK = '#1C2430';
const SOFT = '#5B6573';
const RULE = '#C9CFD8';
const DIFF: Record<string, string> = { basico: 'Básico', intermedio: 'Intermedio', avanzado: 'Avanzado' };

function accentOf(t: ResolvedTheme): string {
  for (const c of [t.color.accentStrong, t.color.accent, t.color.textPrimary]) {
    try {
      if (c && contrastRatio(c, '#FFFFFF') >= 4.5) return c;
    } catch {
      /* siguiente */
    }
  }
  return '#1F3A5F';
}

function allText(doc: any, teacher: boolean): string {
  return JSON.stringify(teacher ? [doc.activity?.title, doc.solution] : doc.activity);
}

export async function renderApplicationPdf(input: ApplicationPdfInput, mode: 'student' | 'teacher'): Promise<ApplicationPdfResult> {
  try {
    return await render(input, mode);
  } catch (err) {
    if (err instanceof Error && /^APPLICATION_PDF_/.test(err.message)) throw err;
    throw new Error(`APPLICATION_PDF_FAILED: pdfkit no pudo generar la Actividad de Aplicación: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
}

async function render(input: ApplicationPdfInput, mode: 'student' | 'teacher'): Promise<ApplicationPdfResult> {
  const a = input.doc?.activity;
  const sol = input.doc?.solution;
  if (!a || (mode === 'teacher' && !sol)) throw new Error('APPLICATION_PDF_INVALID: documento sin actividad o sin solucionario');
  const accent = accentOf(input.theme);
  const T = (s: string) => pdfText(String(s ?? ''));
  const pdf = new PDFDocument({
    size: 'LETTER',
    margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.left, right: PAGE.right },
    bufferPages: true,
    autoFirstPage: false,
    pdfVersion: '1.7',
    lang: 'es-419',
    displayTitle: true,
    compress: true,
    info: {
      Title: T(`${mode === 'teacher' ? 'Solucionario: ' : ''}${a.title}`),
      Subject: (() => { const k = applicationDocKind(input.doc); if (!k) return mode === 'teacher' ? 'Solucionario docente de la Actividad de Aplicación' : 'Actividad de Aplicación'; return mode === 'teacher' ? `Solucionario docente: ${APPLICATION_KIND_LABEL[k]}` : APPLICATION_KIND_LABEL[k]; })(),
      Author: 'Cursia',
      Creator: 'Cursia',
      Producer: 'Cursia (pdfkit)',
      CreationDate: LIBRO_PDF_FIXED_DATE,
      ModDate: LIBRO_PDF_FIXED_DATE,
      ...(input.documentKey ? { Keywords: `cursia:${String(input.documentKey).replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80)}` } : {}),
    },
  } as any);
  const chunks: Buffer[] = [];
  pdf.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve());
    pdf.on('error', reject);
  });
  const W = PAGE.w - PAGE.left - PAGE.right;
  const bottom = () => pdf.page.height - pdf.page.margins.bottom;
  const newPage = () => {
    pdf.addPage();
    pdf.x = PAGE.left;
    pdf.y = PAGE.top;
  };
  const ensure = (h: number) => {
    if (bottom() - pdf.y < h) newPage();
  };
  const text = (s: string, o: { size?: number; bold?: boolean; color?: string; gap?: number; indent?: number } = {}) => {
    const size = o.size ?? 10.5;
    const font = o.bold ? 'Helvetica-Bold' : 'Helvetica';
    const width = W - (o.indent ?? 0);
    pdf.font(font).fontSize(size);
    const h = pdf.heightOfString(T(s), { width, lineGap: 2.5 });
    ensure(Math.min(h, 200) + 4);
    pdf.fillColor(o.color ?? INK).text(T(s), PAGE.left + (o.indent ?? 0), pdf.y, { width, lineGap: 2.5 });
    pdf.y += o.gap ?? 6;
  };
  const head = (s: string) => {
    ensure(60);
    pdf.y += 8;
    text(s, { size: 13, bold: true, color: accent, gap: 6 });
  };
  const lines = (n: number) => {
    for (let i = 0; i < n; i++) {
      ensure(22);
      pdf.y += 18;
      pdf.save().moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + W, pdf.y).lineWidth(0.6).strokeColor(RULE).stroke().restore();
    }
    pdf.y += 8;
  };

  newPage();
  const kind = applicationDocKind(input.doc);
  const kindLabel = kind ? APPLICATION_KIND_LABEL[kind] : 'Actividad de Aplicación';
  text(`${mode === 'teacher' ? 'SOLUCIONARIO DOCENTE · ' : ''}${kindLabel.toUpperCase()} · CAPÍTULO ${input.chapterNumber}`, { size: 8.5, bold: true, color: accent, gap: 4 });
  text(`${input.courseTitle} · ${input.chapterTitle}`, { size: 9, color: SOFT, gap: 10 });
  text(a.title, { size: 19, bold: true, gap: 8 });
  text(`${kind ? kindLabel : APPLICATION_GENRE_LABEL[a.genre] ?? 'Aplicación'} · Tiempo estimado: ${input.doc.minutes} minutos`, { size: 9.5, color: SOFT, gap: 10 });
  if (kind) {
    renderKind({ kind, mode, a, sol, text, head, lines, outcomes: input.outcomes ?? [] });
  } else if (mode === 'student') {
    text('Nombre: ______________________________________    Fecha: _______________', { size: 10, gap: 12 });
    text(`Objetivo: ${a.objective}`, { bold: true });
    text(a.context, { color: SOFT });
    if (a.examples.length) {
      head(a.examples.length === 1 ? 'Ejemplo resuelto' : 'Ejemplos resueltos');
      for (const e of a.examples) {
        text(e.title, { bold: true, gap: 3 });
        text(e.problem);
        e.steps.forEach((s: string, i: number) => text(`${i + 1}. ${s}`, { indent: 12, gap: 3 }));
        text(`Resultado: ${e.result}`, { bold: true, gap: 10 });
      }
    }
    head('Ejercicios');
    a.exercises.forEach((e: any, i: number) => {
      text(`${i + 1}. [${DIFF[e.difficulty] ?? e.difficulty}] ${e.prompt}`, { gap: 2 });
      lines(e.answerLines);
    });
    head(`Taller de aplicación: ${a.workshop.title}`);
    text(a.workshop.situation);
    a.workshop.instructions.forEach((s: string, i: number) => text(`${i + 1}. ${s}`, { indent: 12, gap: 3 }));
    // r79.1: hitos del taller (nivel de 120, v2): cada uno con su producto intermedio.
    if (Array.isArray(a.workshop.milestones) && a.workshop.milestones.length) {
      text('Hitos del taller:', { bold: true, gap: 3 });
      a.workshop.milestones.forEach((m: any, i: number) => text(`${i + 1}. ${m.title} — entregable: ${m.product}`, { indent: 12, gap: 3 }));
    }
    lines(10);
    head('Producto o evidencia');
    text(a.deliverable.description);
    text(`Formato: ${a.deliverable.format} · Extensión: ${a.deliverable.extent}`, { color: SOFT });
    head('Autoevaluación');
    a.selfCheck.forEach((s: string) => text(`[  ] ${s}`, { gap: 4 }));
    head('Criterios de evaluación');
    a.criteria.forEach((c: any) => text(`${c.name} (${c.weight} %): ${c.description}`, { gap: 4 }));
  } else {
    text('Documento solo para docentes: no lo compartas con los estudiantes.', { bold: true, color: '#8A1C1C', gap: 10 });
    head('Respuestas de los ejercicios');
    sol.answers.forEach((x: any, i: number) => {
      text(`${i + 1}. ${a.exercises[i].prompt}`, { color: SOFT, gap: 2 });
      text(`Respuesta: ${x.answer}`, { bold: true, gap: 2 });
      text(`Por qué: ${x.explanation}`, { gap: 10 });
    });
    head('Solución esperada del taller');
    text(sol.workshopSolution);
    head('Guía de corrección por criterio');
    sol.correctionGuide.forEach((g: any, i: number) => {
      text(`${g.criterion} (${criterionForGuide(a.criteria, g, i)?.weight} %)`, { bold: true, gap: 2 });
      text(`Logrado: ${g.achieved}`, { indent: 12, gap: 2 });
      text(`En proceso: ${g.developing}`, { indent: 12, gap: 2 });
      text(`Insuficiente: ${g.insufficient}`, { indent: 12, gap: 8 });
    });
    head('Observaciones para el docente');
    sol.teacherNotes.forEach((s: string) => text(`• ${s}`, { gap: 4 }));
  }
  // Pie con número de página.
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    // El pie va dentro del margen inferior: sin bajar el margen, pdfkit agregaría una página por pie.
    const keep = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    const y = pdf.page.height - 40;
    pdf.font('Helvetica').fontSize(8).fillColor(SOFT).text(T(`Cursia · Página ${i + 1} de ${range.count}`), PAGE.left, y, { width: W, align: 'right', lineBreak: false });
    pdf.page.margins.bottom = keep;
  }
  if (pdf.bufferedPageRange().count !== range.count) throw new Error(`APPLICATION_PDF_FAILED: el pie agregó páginas (${range.count} → ${pdf.bufferedPageRange().count})`);
  pdf.end();
  await done;
  return { pdf: Buffer.concat(chunks), pages: range.count, unmappedChars: unmappedCharCount(allText(input.doc, mode === 'teacher')) };
}

type TextFn = (s: string, o?: { size?: number; bold?: boolean; color?: string; gap?: number; indent?: number }) => void;
const LEVEL: Record<string, string> = { comprender: 'Comprender', analizar: 'Analizar', evaluar: 'Evaluar', proponer: 'Proponer' };

/** r79.1: contenido de los tipos nuevos (mismo documento que la página; el estudiante con renglones para responder). */
function renderKind(x: { kind: string; mode: 'student' | 'teacher'; a: any; sol: any; text: TextFn; head: (s: string) => void; lines: (n: number) => void; outcomes: readonly OutcomeRef[] }): void {
  const { kind, mode, a, sol, text, head, lines } = x;
  const bullets = (xs: string[], o: { numbered?: boolean } = {}) => xs.forEach((s, i) => text(`${o.numbered ? `${i + 1}.` : '•'} ${s}`, { indent: 12, gap: 3 }));
  if (mode === 'student') {
    text('Nombre: ______________________________________    Fecha: _______________', { size: 10, gap: 12 });
    text(`Objetivo: ${a.objective}`, { bold: true });
    if (kind === 'case_study') {
      head(`El caso: ${a.case.title} (${a.case.organization})`);
      String(a.case.narrative).split(/\n+/).filter((p: string) => p.trim()).forEach((p: string) => text(p));
      a.case.exhibits.forEach((e: any, i: number) => { text(`Anexo ${i + 1}: ${e.title}`, { bold: true, gap: 3 }); String(e.content).split(/\n+/).filter((p: string) => p.trim()).forEach((p: string) => text(p, { indent: 12, gap: 3 })); });
      head('Preguntas de análisis');
      a.questions.forEach((q: any, i: number) => { text(`${i + 1}. [${LEVEL[q.level] ?? q.level}] ${q.prompt}`, { gap: 2 }); lines(q.answerLines); });
      head('Tu decisión');
      text(a.decision.prompt);
      text('Condiciones que debes respetar:', { bold: true, gap: 3 });
      bullets(a.decision.constraints);
      lines(10);
    } else if (kind === 'integrative_project') {
      head('El proyecto');
      String(a.brief.situation).split(/\n+/).filter((p: string) => p.trim()).forEach((p: string) => text(p));
      text(`Producto final: ${a.brief.finalProduct}`, { bold: true });
      a.stages.forEach((g: any, i: number) => {
        head(`Etapa ${i + 1} (~${g.minutes} min): ${g.title}`);
        text(g.purpose);
        text(`Se apoya en: ${g.linkedChapter}`, { color: SOFT });
        bullets(g.tasks, { numbered: true });
        text(`Entregable de la etapa: ${g.intermediateDeliverable}`, { bold: true });
        lines(6);
      });
      head('Integración y entrega final');
      bullets(a.integration.instructions, { numbered: true });
      text(`Presentación: ${a.integration.presentation}`, { color: SOFT });
    } else {
      head('Qué vas a revisar');
      text(a.target.product);
      text(`Viene de: ${a.target.sourceActivity}`, { color: SOFT });
      head('Criterios de revisión');
      a.reviewCriteria.forEach((r: any, i: number) => { text(`${i + 1}. ${r.name}: ${r.lookFor}`, { gap: 2 }); bullets(r.questions); lines(3); });
      head('Ejemplar comentado');
      text('Fragmento sólido:', { bold: true, gap: 2 });
      text(a.exemplar.strong, { indent: 12 });
      text('Fragmento por mejorar:', { bold: true, gap: 2 });
      text(a.exemplar.weak, { indent: 12 });
      text(`Por qué: ${a.exemplar.commentary}`);
      head('Errores frecuentes');
      a.commonErrors.forEach((e: any) => text(`• ${e.error} — Cómo detectarlo: ${e.howToSpot} · Cómo corregirlo: ${e.howToFix}`, { gap: 4 }));
      if (a.peerReview) {
        head('Revisión entre pares');
        text(a.peerReview.protocol);
        bullets(a.peerReview.instructions, { numbered: true });
        lines(6);
      }
      head('Plan de mejora y nueva entrega');
      bullets(a.revision.steps, { numbered: true });
      text(`Nueva entrega: ${a.revision.resubmission}`, { bold: true });
      lines(6);
      head('Reflexión');
      a.reflection.forEach((q: string) => { text(`• ${q}`, { gap: 2 }); lines(2); });
    }
    head('Producto o evidencia');
    text(a.deliverable.description);
    text(`Formato: ${a.deliverable.format} · Extensión: ${a.deliverable.extent}`, { color: SOFT });
    head('Autoevaluación');
    a.selfCheck.forEach((s: string) => text(`[  ] ${s}`, { gap: 4 }));
    head('Criterios de evaluación');
    a.criteria.forEach((c: any) => text(`${c.name} (${c.weight} %): ${c.description}`, { gap: 4 }));
    head('Resultados de aprendizaje que evidencias');
    const textOf = new Map(x.outcomes.map((o) => [o.id, o.text]));
    a.outcomeLinks.forEach((o: any) => { const t = textOf.get(o.outcomeId); text(`• ${t ? (o.outcomeId === 'OBJ' ? t : `${o.outcomeId}: ${t}`) : o.outcomeId} — ${o.evidence}`, { gap: 4 }); });
    return;
  }
  text('Documento solo para docentes: no lo compartas con los estudiantes.', { bold: true, color: '#8A1C1C', gap: 10 });
  if (kind === 'case_study') {
    head('Análisis esperado de cada pregunta');
    sol.questionGuides.forEach((g: any, i: number) => { text(`${i + 1}. ${a.questions[i]?.prompt ?? ''}`, { color: SOFT, gap: 2 }); text(g.expectedAnalysis, { gap: 2 }); bullets(g.keyPoints); });
    head('Decisión: discusión');
    text(`Recomendada: ${sol.decisionDiscussion.recommended}`, { bold: true });
    text('Alternativas aceptables:', { bold: true, gap: 2 });
    bullets(sol.decisionDiscussion.alternatives);
    text(`Justificación: ${sol.decisionDiscussion.justification}`);
    head('Preguntas para la discusión en clase');
    bullets(sol.discussionQuestions);
  } else if (kind === 'integrative_project') {
    head('Guía de cada etapa');
    sol.stageGuides.forEach((g: any, i: number) => {
      text(`Etapa ${i + 1}: ${a.stages[i]?.title ?? ''}`, { bold: true, gap: 2 });
      text(`Producto esperado: ${g.expectedOutput}`, { gap: 2 });
      text('Errores frecuentes:', { bold: true, gap: 2 });
      bullets(g.commonErrors);
      text('Preguntas de control:', { bold: true, gap: 2 });
      bullets(g.checkpointQuestions);
    });
    head('Ejemplo de producto final');
    text(sol.finalProductExemplar);
  } else {
    head('Banco de retroalimentación por criterio de revisión');
    sol.feedbackBank.forEach((g: any) => {
      text(g.criterion, { bold: true, gap: 2 });
      text(`Logrado: ${g.achieved}`, { indent: 12, gap: 2 });
      text(`En proceso: ${g.developing}`, { indent: 12, gap: 2 });
      text(`Insuficiente: ${g.insufficient}`, { indent: 12, gap: 2 });
      text(`Comentario sugerido: ${g.feedbackComment}`, { indent: 12, gap: 2 });
      text(`Siguiente paso: ${g.nextStep}`, { indent: 12, gap: 8 });
    });
    head('Diagnóstico de errores');
    sol.errorGuide.forEach((e: any) => text(`• ${e.error} — ${e.diagnosis}`, { gap: 4 }));
  }
  head('Guía de corrección por criterio');
  sol.correctionGuide.forEach((g: any, i: number) => {
    text(`${g.criterion} (${criterionForGuide(a.criteria, g, i)?.weight} %)`, { bold: true, gap: 2 });
    text(`Logrado: ${g.achieved}`, { indent: 12, gap: 2 });
    text(`En proceso: ${g.developing}`, { indent: 12, gap: 2 });
    text(`Insuficiente: ${g.insufficient}`, { indent: 12, gap: 8 });
  });
  head('Observaciones para el docente');
  sol.teacherNotes.forEach((s: string) => text(`• ${s}`, { gap: 4 }));
}
