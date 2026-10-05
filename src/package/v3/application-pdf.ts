// Fase 2 · Actividades de Aplicación — PDF imprimible (pdfkit), generado del MISMO documento que la página HTML:
//   - estudiante: la actividad con renglones para responder cada ejercicio en papel (answerLines) y espacio para el
//     taller; SIN respuestas;
//   - docente: el solucionario (respuestas, solución del taller, guía de corrección, observaciones).
// Fuentes estándar (WinAnsi) con la misma transliteración del Libro Guía (`pdfText`); fecha fija → bytes estables.
import PDFDocument = require('pdfkit');
import type { ResolvedTheme } from '../../modules/theme-engine';
import { contrastRatio } from '../../modules/theme-engine';
import { APPLICATION_GENRE_LABEL } from '../../modules/course-shell/application-pages';
import { LIBRO_PDF_FIXED_DATE, pdfText, unmappedCharCount } from './libro-v3';

export interface ApplicationPdfInput {
  courseTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  doc: any;
  theme: ResolvedTheme;
  /** Clave determinística del documento (sha del artifact): va en /Keywords. */
  documentKey?: string;
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
      Subject: mode === 'teacher' ? 'Solucionario docente de la Actividad de Aplicación' : 'Actividad de Aplicación',
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
  text(`${mode === 'teacher' ? 'SOLUCIONARIO DOCENTE · ' : ''}ACTIVIDAD DE APLICACIÓN · CAPÍTULO ${input.chapterNumber}`, { size: 8.5, bold: true, color: accent, gap: 4 });
  text(`${input.courseTitle} · ${input.chapterTitle}`, { size: 9, color: SOFT, gap: 10 });
  text(a.title, { size: 19, bold: true, gap: 8 });
  text(`${APPLICATION_GENRE_LABEL[a.genre] ?? 'Aplicación'} · Tiempo estimado: ${input.doc.minutes} minutos`, { size: 9.5, color: SOFT, gap: 10 });
  if (mode === 'student') {
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
      text(`${g.criterion} (${a.criteria[i].weight} %)`, { bold: true, gap: 2 });
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
