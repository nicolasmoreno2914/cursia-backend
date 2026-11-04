import PDFDocument = require('pdfkit');
import { cursiaDefaultLogo } from '../../package/v3/libro-logo';
import { pdfText } from '../../package/v3/libro-v3';
import { formatDateEs } from '../prebrief/prebrief-document';
import { BLOOM_LABEL, MODALITY_LABEL, MicrocurriculumAnswers, MicrocurriculumIssue, MicrocurriculumV1, terminologyFor } from './microcurriculum.types';
import { MC_PDF_ATTACHMENT, buildMicrocurriculumPdfPayload } from './pdf-payload';

/**
 * r81 · Microcurrículo · PDF (pdfkit, fuentes estándar WinAnsi, Carta) — spec §3. Renderizador SIN lógica: dibuja el
 * documento tal como quedó en la revisión. Mismas convenciones que prebrief-pdf.ts (Carta, `pdfText`, determinista: la
 * fecha del PDF es `meta.date`, así el mismo documento y la misma fecha dan los mismos bytes).
 *
 * Portada (logo de la cuenta o Cursia, curso, institución/programa, tipo, docente, fecha, «Microcurrículo»; nota
 * «Revisar: …» si quedan comprobaciones sin resolver) + secciones numeradas (Competencias solo si hay) + pie
 * «Página x de y · curso». Sin marca de agua.
 */

const PAGE = { w: 612, h: 792, top: 70, bottom: 70, left: 62, right: 62 };
const W = PAGE.w - PAGE.left - PAGE.right;
const C = {
  ink: '#1B2433', soft: '#5B6573', faint: '#8A94A3', line: '#D5DBE3', fill: '#F2F5F7', navy: '#173B5C',
  accent: '#0E716D', accentSoft: '#E3F1EF', warn: '#8A5205', warnSoft: '#F7EBD6',
};
/** pdfText convierte los saltos de línea en espacios: se aplica por línea para conservar los párrafos (review P2-11). */
const T = (s: unknown) => String(s == null ? '' : s).split(/\r?\n/).map((l) => pdfText(l)).join('\n');
const fmtH = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace('.', ','));

export interface MicrocurriculumPdfMeta {
  /** Logo de la cuenta (PNG/JPEG ya validado); null → logo de Cursia. */
  logo?: Buffer | null;
  author?: string | null;
  date: Date;
  issues: MicrocurriculumIssue[];
  /**
   * r86 · Copia legible por máquina (adjunto `cursia-microcurriculum.json`, ver pdf-payload.ts) para que «Importar
   * microcurrículo» lea este PDF sin pérdidas. No cambia ninguna página. Sin `embed`, el PDF no la trae.
   */
  embed?: { microcurriculumId: string | null; answers: MicrocurriculumAnswers } | null;
}
export interface MicrocurriculumPdfResult { pdf: Buffer; pages: number }

/** Títulos de sección en orden (Competencias solo si hay); los numera el PDF y los usa la prueba. */
export function microcurriculumSectionTitles(mc: MicrocurriculumV1): string[] {
  const t = terminologyFor(mc.identification.institutionType);
  return [
    'Identificación', 'Descripción y justificación', `Perfil del ${t.learner} y prerrequisitos`, 'Objetivos', t.outcomesLabel,
    ...(mc.competencies.length ? ['Competencias'] : []),
    'Unidades temáticas', 'Distribución de horas', 'Metodología', 'Evaluación', 'Recursos', 'Bibliografía',
  ];
}

export async function renderMicrocurriculumPdf(mc: MicrocurriculumV1, meta: MicrocurriculumPdfMeta): Promise<MicrocurriculumPdfResult> {
  const id = mc.identification;
  const term = terminologyFor(id.institutionType);
  const date = meta.date;
  const pdf = new PDFDocument({
    size: [PAGE.w, PAGE.h],
    margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.left, right: PAGE.right },
    bufferPages: true,
    autoFirstPage: false,
    pdfVersion: '1.7',
    lang: 'es-419',
    displayTitle: true,
    compress: true,
    info: {
      Title: T(`${id.courseName} · Microcurrículo`),
      Subject: T(`Microcurrículo · ${term.institutionLabel}`),
      Author: T(meta.author || 'Cursia'),
      Creator: 'Cursia',
      Producer: 'Cursia (pdfkit)',
      CreationDate: date,
      ModDate: date,
    },
  } as any);
  const chunks: Buffer[] = [];
  pdf.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((resolve, reject) => { pdf.on('end', () => resolve()); pdf.on('error', reject); });

  // ── utilidades de flujo ──
  const bottom = () => PAGE.h - PAGE.bottom;
  const newPage = () => { pdf.addPage(); pdf.x = PAGE.left; pdf.y = PAGE.top; };
  const ensure = (h: number) => { if (pdf.y + h > bottom()) newPage(); };
  const font = (bold: boolean, size: number, color = C.ink) => pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const hOf = (s: string, width: number, bold: boolean, size: number) => { font(bold, size); return pdf.heightOfString(T(s), { width, lineGap: 2 }); };
  const write = (s: string, x: number, width: number, bold: boolean, size: number, color = C.ink, opts: Record<string, unknown> = {}) => {
    font(bold, size, color);
    pdf.text(T(s), x, pdf.y, { width, lineGap: 2, ...opts });
  };
  const paragraph = (s: string, color = C.ink) => {
    if (!s) return;
    ensure(Math.min(hOf(s, W, false, 10.5), 80));
    write(s, PAGE.left, W, false, 10.5, color);
    pdf.y += 6;
  };
  const subheading = (s: string) => {
    ensure(hOf(s, W, true, 11) + 50);
    pdf.y += 2;
    write(s, PAGE.left, W, true, 11, C.navy);
    pdf.y += 3;
  };
  const bullets = (items: string[], note?: (i: number) => string | null) => {
    items.forEach((it, i) => {
      const n = note ? note(i) : null;
      const h = hOf(it, W - 16, false, 10.5) + (n ? hOf(n, W - 16, false, 8.5) : 0) + 4;
      ensure(h);
      const y = pdf.y;
      font(true, 10.5, C.accent); pdf.text('•', PAGE.left + 2, y, { width: 10 });
      pdf.y = y;
      write(it, PAGE.left + 16, W - 16, false, 10.5);
      if (n) write(n, PAGE.left + 16, W - 16, false, 8.5, C.warn);
      pdf.y += 4;
    });
  };
  /** Filas etiqueta → valor; un valor lista se dibuja una línea por elemento (pdfText colapsa los saltos de línea). */
  const kv = (rows: [string, string | string[]][]) => {
    const lw = 150;
    for (const [k, v] of rows) {
      const lines = Array.isArray(v) ? v : [v];
      const vh = lines.reduce((a, l) => a + hOf(l, W - lw, false, 10.5), 0) + (lines.length - 1) * 2;
      const h = Math.max(hOf(k, lw - 10, true, 9), vh) + 10;
      ensure(h);
      const y = pdf.y;
      font(true, 9, C.soft); pdf.text(T(k), PAGE.left, y + 1, { width: lw - 10, lineGap: 2 });
      pdf.y = y;
      lines.forEach((l, i) => { if (i) pdf.y += 2; write(l, PAGE.left + lw, W - lw, false, 10.5); });
      pdf.y = Math.max(pdf.y, y + h - 10) + 5;
      pdf.moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + W, pdf.y).lineWidth(0.4).strokeColor(C.line).stroke();
      pdf.y += 5;
    }
  };
  /** Tabla con encabezado repetido al cambiar de página; filas que no se cortan. */
  const table = (cols: { label: string; w: number; align?: 'left' | 'right' | 'center' }[], rows: string[][], opts: { totalRow?: string[] } = {}) => {
    const total = cols.reduce((a, c) => a + c.w, 0);
    const widths = cols.map((c) => (c.w / total) * W);
    const xs = widths.map((_, i) => PAGE.left + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const head = () => {
      const hh = Math.max(...cols.map((c, i) => hOf(c.label, widths[i] - 10, true, 8))) + 10;
      const y = pdf.y;
      pdf.rect(PAGE.left, y, W, hh).fill(C.fill);
      cols.forEach((c, i) => { font(true, 8, C.soft); pdf.text(T(c.label), xs[i] + 5, y + 5, { width: widths[i] - 10, align: c.align || 'left', lineGap: 2 }); });
      pdf.y = y + hh;
    };
    const rowH = (r: string[], bold: boolean) => Math.max(...r.map((cell, i) => hOf(cell, widths[i] - 10, bold, 9))) + 10;
    ensure(30 + (rows.length ? rowH(rows[0], false) : 0));
    head();
    const draw = (r: string[], bold: boolean) => {
      const rh = rowH(r, bold);
      if (pdf.y + rh > bottom()) { newPage(); head(); }
      const y = pdf.y;
      r.forEach((cell, i) => { font(bold, 9, C.ink); pdf.text(T(cell), xs[i] + 5, y + 5, { width: widths[i] - 10, align: cols[i].align || 'left', lineGap: 2 }); });
      pdf.y = y + rh;
      pdf.moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + W, pdf.y).lineWidth(0.4).strokeColor(C.line).stroke();
    };
    rows.forEach((r) => draw(r, false));
    if (opts.totalRow) draw(opts.totalRow, true);
    pdf.y += 8;
  };

  // ── portada ──
  newPage();
  const lw = 132;
  let logoBytes: Buffer = cursiaDefaultLogo().bytes;
  if (meta.logo && meta.logo.length) logoBytes = meta.logo;
  const img = (pdf as any).openImage(logoBytes);
  const lh = Math.min(90, (img.height / img.width) * lw);
  pdf.image(img, PAGE.left, 58, { fit: [lw, lh] } as any);
  pdf.rect(PAGE.left, 200, 150, 3).fill(C.accent);
  pdf.y = 222;
  write('MICROCURRÍCULO', PAGE.left, W, true, 10, C.accent, { characterSpacing: 1.4 });
  pdf.y += 8;
  write(id.courseName, PAGE.left, W, true, id.courseName.length > 90 ? 20 : id.courseName.length > 60 ? 24 : 28, C.ink);
  pdf.y += 8;
  const sub = [id.program, id.area].filter(Boolean).join(' · ');
  if (sub) write(sub, PAGE.left, W, false, 13, C.soft);
  write(term.institutionLabel, PAGE.left, W, false, 12, C.soft);
  pdf.y = Math.max(pdf.y + 34, 430);
  const coverRows: [string, string][] = [
    ['Docente', meta.author || 'Sin indicar'],
    ['Fecha', formatDateEs(date.toISOString())],
    ['Intensidad', `${fmtH(mc.totalHours)} horas`],
    ...(id.code ? [['Código', id.code] as [string, string]] : []),
  ];
  for (const [k, v] of coverRows) {
    const y = pdf.y;
    font(true, 9, C.soft); pdf.text(T(k.toUpperCase()), PAGE.left, y, { width: 90, characterSpacing: 0.8 });
    font(false, 11, C.ink); pdf.text(T(v), PAGE.left + 96, y - 1, { width: W - 96 });
    pdf.y = Math.max(pdf.y, y + 20);
  }
  if (meta.issues.length) {
    pdf.y += 14;
    const shown = meta.issues.slice(0, 5).map((i) => `${i.code} · ${i.message}`);
    const more = meta.issues.length > 5 ? [`y ${meta.issues.length - 5} comprobación(es) más en Cursia.`] : [];
    const lines = [...shown, ...more];
    const h = 26 + lines.reduce((a, l) => a + hOf(l, W - 28, false, 9) + 2, 0);
    const y = pdf.y;
    pdf.rect(PAGE.left, y, W, h).fill(C.warnSoft);
    pdf.y = y + 9;
    write('Revisar: quedan comprobaciones sin resolver', PAGE.left + 14, W - 28, true, 10, C.warn);
    for (const l of lines) { write(l, PAGE.left + 14, W - 28, false, 9, C.warn); pdf.y += 2; }
    pdf.y = y + h;
  }
  pdf.y = PAGE.h - 110;
  write('Preparado con Cursia · Microcurrículo', PAGE.left, W, false, 9, C.soft);

  // ── secciones ──
  const titles = microcurriculumSectionTitles(mc);
  let n = 0;
  const section = (title: string) => {
    n++;
    ensure(120);
    if (pdf.y > PAGE.top + 4) pdf.y += 16;
    const y0 = pdf.y;
    font(true, 12, C.accent); pdf.text(T(String(n)), PAGE.left, y0 + 3, { width: 26 });
    font(true, 16, C.ink); pdf.text(T(title), PAGE.left + 28, y0, { width: W - 28 });
    pdf.y += 2;
    pdf.moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + W, pdf.y).lineWidth(0.6).strokeColor(C.line).stroke();
    pdf.y += 10;
  };
  newPage();

  section(titles[n]);
  kv([
    ['Nombre del curso', id.courseName],
    ['Tipo de institución', term.institutionLabel],
    ...(id.program ? [['Programa', id.program] as [string, string]] : []),
    ...(id.term ? [['Semestre / grado', id.term] as [string, string]] : []),
    ...(id.modality ? [['Modalidad', MODALITY_LABEL[id.modality]] as [string, string]] : []),
    ...(id.code ? [['Código', id.code] as [string, string]] : []),
    ...(id.area ? [['Área', id.area] as [string, string]] : []),
    ['Intensidad horaria', `${fmtH(mc.totalHours)} horas`],
    ...(meta.author ? [['Docente', meta.author] as [string, string]] : []),
  ]);

  section(titles[n]);
  subheading('Descripción');
  paragraph(mc.description);
  subheading('Justificación');
  paragraph(mc.justification);

  section(titles[n]);
  subheading(`Perfil del ${term.learner}`);
  paragraph(mc.learnerProfile);
  subheading('Conocimientos previos');
  paragraph(mc.priorKnowledge || 'No se requieren conocimientos previos específicos.');

  section(titles[n]);
  subheading('Objetivo general');
  paragraph(mc.generalObjective);
  subheading('Objetivos específicos');
  bullets(mc.specificObjectives);

  section(titles[n]);
  table(
    [{ label: 'Id', w: 9 }, { label: term.outcomesLabel, w: 46 }, { label: 'Verbo · Bloom', w: 18 }, { label: 'Criterio', w: 27 }],
    mc.outcomes.map((o) => [o.id, o.text, `${o.verb} · ${BLOOM_LABEL[o.bloom] || o.bloom}`, o.criterion]),
  );

  if (mc.competencies.length) {
    section(titles[n]);
    table([{ label: 'Id', w: 10 }, { label: 'Competencia', w: 90 }], mc.competencies.map((c) => [c.id, c.text]));
  }

  section(titles[n]);
  for (const u of mc.units) {
    const total = u.hours.contact + u.hours.practice + u.hours.autonomous;
    const head = `${u.id} · ${u.title}`;
    // La unidad no se corta si cabe entera en una página (encabezado + filas); si no cabe, al menos su comienzo.
    const block = hOf(head, W - 90, true, 11) + 18 + u.contents.reduce((a, c) => a + hOf(`• ${c}`, W - 150, false, 10.5) + 2, 0)
      + [u.strategy, u.mainActivity].reduce((a, x) => a + hOf(x || '-', W - 150, false, 10.5), 0) + 6 * 20;
    if (pdf.y + block > bottom() && block <= bottom() - PAGE.top) newPage();
    else ensure(hOf(head, W - 80, true, 11) + 90);
    const y = pdf.y;
    const hh = hOf(head, W - 90, true, 11) + 12;
    pdf.rect(PAGE.left, y, W, hh).fill(C.fill);
    font(true, 11, C.ink); pdf.text(T(head), PAGE.left + 10, y + 6, { width: W - 90, lineGap: 2 });
    font(true, 10, C.ink); pdf.text(T(`${fmtH(total)} h`), PAGE.left + W - 78, y + 6, { width: 70, align: 'right' });
    pdf.y = y + hh + 6;
    kv([
      ['Contenidos', u.contents.map((c) => `• ${c}`)],
      [term.outcomesLabel, u.outcomeIds.join(', ') || '-'],
      ['Horas (D / P / A)', `${fmtH(u.hours.contact)} / ${fmtH(u.hours.practice)} / ${fmtH(u.hours.autonomous)}`],
      ['Semanas', u.weeks ? (u.weeks.from === u.weeks.to ? `${u.weeks.from}` : `${u.weeks.from} a ${u.weeks.to}`) : 'Según el calendario institucional'],
      ['Estrategia', u.strategy || '-'],
      ['Actividad principal', u.mainActivity || '-'],
    ]);
    pdf.y += 6;
  }

  section(titles[n]);
  const sumK = (k: 'contact' | 'practice' | 'autonomous') => mc.units.reduce((a, u) => a + u.hours[k], 0);
  table(
    [{ label: 'Unidad', w: 44 }, { label: 'Docente', w: 14, align: 'right' }, { label: 'Práctica', w: 14, align: 'right' }, { label: 'Autónomo', w: 14, align: 'right' }, { label: 'Total', w: 14, align: 'right' }],
    mc.units.map((u) => [`${u.id} · ${u.title}`, fmtH(u.hours.contact), fmtH(u.hours.practice), fmtH(u.hours.autonomous), fmtH(u.hours.contact + u.hours.practice + u.hours.autonomous)]),
    { totalRow: ['Total', fmtH(sumK('contact')), fmtH(sumK('practice')), fmtH(sumK('autonomous')), fmtH(sumK('contact') + sumK('practice') + sumK('autonomous'))] },
  );
  write('D: trabajo con el docente · P: práctica · A: trabajo autónomo.', PAGE.left, W, false, 8.5, C.soft);

  section(titles[n]);
  paragraph(mc.methodology.text);
  if (mc.methodology.strategies.length) {
    subheading('Estrategias didácticas');
    bullets(mc.methodology.strategies);
  }

  section(titles[n]);
  const pct = mc.evaluation.reduce((a, e) => a + e.percent, 0);
  table(
    [{ label: 'Momento', w: 28 }, { label: '%', w: 8, align: 'right' }, { label: term.outcomesLabel, w: 16 }, { label: 'Semana', w: 10, align: 'center' }, { label: 'Evidencia', w: 38 }],
    mc.evaluation.map((e) => [e.name, `${fmtH(e.percent)} %`, e.outcomeIds.join(', '), e.week ? String(e.week) : '-', e.evidence]),
    { totalRow: ['Total', `${fmtH(pct)} %`, '', '', ''] },
  );

  section(titles[n]);
  if (mc.resources.length) bullets(mc.resources);
  else paragraph('Sin recursos adicionales.', C.soft);

  section(titles[n]);
  if (mc.bibliography.length) bullets(mc.bibliography.map((b) => b.text), (i) => (mc.bibliography[i].origin === 'sugerida' ? 'Sugerida por Cursia: verificar disponibilidad.' : null));
  else paragraph('Sin bibliografía registrada.', C.soft);

  // ── pie en todas las páginas ──
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const keepB = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.moveTo(PAGE.left, PAGE.h - 48).lineTo(PAGE.left + W, PAGE.h - 48).lineWidth(0.5).strokeColor(C.line).stroke();
    font(false, 8, C.soft);
    let name = T(id.courseName);
    while (name.length > 8 && pdf.widthOfString(name) > W - 130) name = `${name.slice(0, -2).trimEnd()}…`;
    pdf.text(name, PAGE.left, PAGE.h - 40, { width: W - 120, lineBreak: false });
    pdf.text(T(`Página ${i - range.start + 1} de ${range.count}`), PAGE.left + W - 120, PAGE.h - 40, { width: 120, align: 'right', lineBreak: false });
    pdf.page.margins.bottom = keepB;
  }
  if (meta.embed) {
    pdf.file(buildMicrocurriculumPdfPayload(mc, meta.embed.answers, meta.embed.microcurriculumId), {
      name: MC_PDF_ATTACHMENT, type: 'application/json', relationship: 'Data',
      description: 'Cursia · copia exacta del microcurrículo (para importarlo sin pérdidas)',
      creationDate: date, modifiedDate: date,
    } as any);
  }
  if (pdf.bufferedPageRange().count !== range.count) throw new Error(`MICROCURRICULUM_PDF_FAILED: el pie agregó páginas (${range.count} → ${pdf.bufferedPageRange().count})`);
  pdf.end();
  await done;
  return { pdf: Buffer.concat(chunks), pages: range.count };
}
