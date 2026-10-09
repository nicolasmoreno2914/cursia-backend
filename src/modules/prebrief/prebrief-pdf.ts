import PDFDocument = require('pdfkit');
import { cursiaDefaultLogo } from '../../package/v3/libro-logo';
import { LIBRO_PDF_FIXED_DATE, pdfText } from '../../package/v3/libro-v3';
import { DocBlock, PrebriefDocument, PrebriefDocumentMeta, STATUS_LABEL, approvalStateTexts, formatDateEs } from './prebrief-document';

/**
 * Prebrief pedagógico · PDF (pdfkit, fuentes estándar WinAnsi como el Libro Guía). Renderizador SIN lógica: dibuja el
 * PrebriefDocument (los mismos bloques y textos que la interfaz) más el estado de la versión. Determinista: la fecha del
 * PDF es la de la versión (o una fija en borrador) → el mismo documento y estado dan los mismos bytes.
 *
 * Diseño: Carta, una columna de ~70 caracteres, portada con logo Cursia, «El curso en una mirada», secciones numeradas,
 * tablas limpias (módulos que no se cortan si caben en la página siguiente, encabezado de tabla repetido), encabezado y
 * pie con versión, estado, huella y «Página x de y». Borrador: marca de agua; aprobado: sello; invalidado: franja roja.
 */

const PAGE = { w: 612, h: 792, top: 76, bottom: 70, left: 62, right: 62 };
const W = PAGE.w - PAGE.left - PAGE.right;
const C = {
  ink: '#1B2433', soft: '#5B6573', faint: '#8A94A3', line: '#D5DBE3', fill: '#F2F5F7', navy: '#173B5C',
  accent: '#0E716D', accentSoft: '#E3F1EF', warn: '#8A5205', warnSoft: '#F7EBD6', ok: '#1D6E43', okSoft: '#E2F2E8', crit: '#A3222B', critSoft: '#F8E1E2',
};
const ORIGIN_COLOR: Record<string, string> = { requirement: C.accent, exception: C.warn };
const T = (s: unknown) => pdfText(String(s == null ? '' : s));

export interface PrebriefPdfResult { pdf: Buffer; pages: number }

export async function renderPrebriefPdf(document: PrebriefDocument, meta: PrebriefDocumentMeta): Promise<PrebriefPdfResult> {
  const date = meta.status === 'approved' && meta.approval ? new Date(meta.approval.at) : meta.date ? new Date(meta.date) : LIBRO_PDF_FIXED_DATE;
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
      Title: T(`${document.cover.title} · Propuesta de diseño pedagógico`),
      Subject: T(`Propuesta de diseño pedagógico${meta.version !== null ? ` · versión ${meta.version}` : ' · borrador'} · ${STATUS_LABEL[meta.status]}`),
      Author: 'Cursia',
      Creator: 'Cursia',
      Producer: 'Cursia (pdfkit)',
      CreationDate: date,
      ModDate: date,
      Keywords: `cursia:prebrief:${meta.fingerprint.slice(0, 64)}`,
    },
  } as any);
  const chunks: Buffer[] = [];
  pdf.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((resolve, reject) => { pdf.on('end', () => resolve()); pdf.on('error', reject); });

  const logo = cursiaDefaultLogo();
  const logoImg = (pdf as any).openImage(logo.bytes);

  // ── utilidades de flujo ──
  const bottom = () => PAGE.h - PAGE.bottom;
  const newPage = () => { pdf.addPage(); pdf.x = PAGE.left; pdf.y = PAGE.top; };
  const ensure = (h: number) => { if (pdf.y + h > bottom()) newPage(); };
  const font = (bold: boolean, size: number, color = C.ink) => pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const hOf = (s: string, width: number, bold: boolean, size: number, lineGap = 2) => { font(bold, size); return pdf.heightOfString(T(s), { width, lineGap }); };
  const write = (s: string, x: number, width: number, bold: boolean, size: number, color = C.ink, opts: Record<string, unknown> = {}) => {
    font(bold, size, color);
    pdf.text(T(s), x, pdf.y, { width, lineGap: 2, ...opts });
  };
  const originLine = (b: { origin?: { key: string; label: string }; evidence?: { quote: string; page: number | null } }, x: number, width: number) => {
    if (b.origin) {
      font(b.origin.key === 'requirement' || b.origin.key === 'exception', 7.5, ORIGIN_COLOR[b.origin.key] || C.faint);
      pdf.text(T(b.origin.label.toUpperCase()), x, pdf.y + 1, { width, characterSpacing: 0.5 });
    }
    if (b.evidence) {
      pdf.font('Helvetica-Oblique').fontSize(8).fillColor(C.faint);
      pdf.text(T(`«${b.evidence.quote}»${b.evidence.page ? ` (p. ${b.evidence.page})` : ''}`), x, pdf.y + 1, { width, lineGap: 1 });
    }
  };
  const originH = (b: { origin?: unknown; evidence?: { quote: string; page: number | null } }, width: number) =>
    (b.origin ? 11 : 0) + (b.evidence ? (pdf.font('Helvetica-Oblique').fontSize(8), pdf.heightOfString(T(`«${b.evidence.quote}» (p. 0)`), { width, lineGap: 1 }) + 2) : 0);

  // ── portada ──
  newPage();
  const lw = 132;
  pdf.image(logoImg, PAGE.left, 58, { width: lw, height: (logo.height / logo.width) * lw } as any);
  pdf.rect(PAGE.left, 210, 150, 3).fill(C.accent);
  pdf.y = 232;
  write(document.cover.kicker.toUpperCase(), PAGE.left, W, true, 10, C.accent, { characterSpacing: 1.4 });
  pdf.y += 8;
  write(document.cover.title, PAGE.left, W, true, document.cover.title.length > 90 ? 20 : document.cover.title.length > 60 ? 24 : 28, C.ink);
  pdf.y += 8;
  for (const s of document.cover.subtitle) write(s, PAGE.left, W, false, 13, C.soft);
  pdf.y = Math.max(pdf.y + 40, 470);
  const coverRows: [string, string][] = [
    ['Versión', meta.version !== null ? String(meta.version) : 'Borrador (sin versión)'],
    ['Fecha', meta.date ? formatDateEs(meta.date) : 'Vista previa'],
    ['Estado', STATUS_LABEL[meta.status]],
  ];
  for (const [k, v] of coverRows) {
    const y = pdf.y;
    font(true, 9, C.soft); pdf.text(T(k.toUpperCase()), PAGE.left, y, { width: 90, characterSpacing: 0.8 });
    font(meta.status === 'approved' && k === 'Estado', 11, k === 'Estado' ? statusColor(meta.status) : C.ink); pdf.text(T(v), PAGE.left + 96, y - 1, { width: W - 96 });
    pdf.y = y + 20;
  }
  if (meta.status === 'approved' && meta.approval) {
    pdf.y += 10;
    const y = pdf.y;
    pdf.roundedRect(PAGE.left, y, W, 66, 4).lineWidth(1).strokeColor(C.ok).stroke();
    pdf.y = y + 10;
    write('APROBADO', PAGE.left + 14, W - 28, true, 11, C.ok, { characterSpacing: 1.2 });
    write(`${meta.approval.name} · ${meta.approval.role}`, PAGE.left + 14, W - 28, false, 10, C.ink);
    write(formatDateEs(meta.approval.at, true), PAGE.left + 14, W - 28, false, 9, C.soft);
    pdf.y = y + 76;
  }
  pdf.y = PAGE.h - 112;
  write('Preparado con Cursia · Propuesta de diseño pedagógico', PAGE.left, W, false, 9, C.soft);
  write(`Código de verificación: ${meta.fingerprint.slice(0, 8)}`, PAGE.left, W, false, 8, C.faint);

  // ── secciones ──
  newPage();
  for (const s of document.sections) {
    // Cada sección nueva arranca con al menos su título y unas líneas; la de aprobación, en página propia si no cabe.
    // Una sección de un solo bloque corto (p. ej. el anexo) no necesita 130pt: así no queda sola en una página nueva.
    ensure(s.id === 'approval' ? 260 : s.blocks.length <= 1 ? 90 : 130);
    if (pdf.y > PAGE.top + 4) pdf.y += 14;
    const y0 = pdf.y;
    if (s.n) { font(true, 12, C.accent); pdf.text(T(s.n), PAGE.left, y0 + 3, { width: 26 }); }
    font(true, 16, C.ink);
    pdf.text(T(s.title), PAGE.left + (s.n ? 28 : 0), y0, { width: W - (s.n ? 28 : 0) });
    pdf.y += 2;
    pdf.moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + W, pdf.y).lineWidth(0.6).strokeColor(C.line).stroke();
    pdf.y += 10;
    for (const b of s.blocks) { drawBlock(b); pdf.y += 8; }
    if (s.id === 'approval') drawState();
  }

  function drawBlock(b: DocBlock) {
    switch (b.t) {
      case 'figures': {
        const n = b.items.length || 1;
        const cw = W / n;
        ensure(60);
        const y = pdf.y;
        pdf.rect(PAGE.left, y, W, 56).fill(C.fill);
        b.items.forEach((it, i) => {
          const x = PAGE.left + i * cw + 12;
          font(true, 17, C.ink); pdf.text(T(it.value), x, y + 10, { width: cw - 20, lineBreak: false });
          font(false, 8, C.soft); pdf.text(T(it.label), x, y + 32, { width: cw - 20, height: 24 });
          if (i) pdf.moveTo(PAGE.left + i * cw, y + 10).lineTo(PAGE.left + i * cw, y + 46).lineWidth(0.6).strokeColor(C.line).stroke();
        });
        pdf.y = y + 64;
        break;
      }
      case 'subheading': {
        // Un subtítulo nunca queda solo al pie: arrastra al menos el comienzo de lo que sigue.
        ensure(hOf(b.text, W, true, 11) + 60);
        pdf.y += 2;
        write(b.text, PAGE.left, W, true, 11, C.navy);
        pdf.y += 2;
        break;
      }
      case 'paragraph': {
        const h = hOf(b.text, W, false, 10.5) + originH(b, W);
        ensure(Math.min(h, 120));
        write(b.text, PAGE.left, W, false, 10.5, b.muted ? C.soft : C.ink);
        originLine(b, PAGE.left, W);
        break;
      }
      case 'kv': {
        const lw2 = 140;
        for (const r of b.rows) {
          const h = Math.max(hOf(r.label, lw2 - 10, true, 9), hOf(r.value, W - lw2, false, 10.5) + originH(r, W - lw2)) + 10;
          ensure(h);
          const y = pdf.y;
          font(true, 9, C.soft); pdf.text(T(r.label), PAGE.left, y + 1, { width: lw2 - 10, lineGap: 2 });
          pdf.y = y;
          write(r.value, PAGE.left + lw2, W - lw2, false, 10.5);
          originLine(r, PAGE.left + lw2, W - lw2);
          pdf.y = Math.max(pdf.y, y + h - 10) + 5;
          pdf.moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + W, pdf.y).lineWidth(0.4).strokeColor(C.line).stroke();
          pdf.y += 5;
        }
        break;
      }
      case 'list': {
        for (const it of b.items) {
          const h = hOf(it.text, W - 16, false, 10.5) + (it.note ? hOf(it.note, W - 16, false, 9) : 0) + originH(it, W - 16) + 6;
          ensure(h);
          const y = pdf.y;
          font(true, 10.5, C.accent); pdf.text('•', PAGE.left + 2, y, { width: 10 });
          pdf.y = y;
          write(it.text, PAGE.left + 16, W - 16, false, 10.5);
          if (it.note) write(it.note, PAGE.left + 16, W - 16, false, 9, C.soft);
          originLine(it, PAGE.left + 16, W - 16);
          pdf.y += 5;
        }
        break;
      }
      case 'outcomes': {
        for (const it of b.items) {
          const h = hOf(it.text, W - 44, false, 10.5) + hOf(it.note, W - 44, false, 9) + originH(it, W - 44) + 10;
          ensure(h);
          const y = pdf.y;
          font(true, 10, C.accent); pdf.text(T(it.id), PAGE.left, y + 0.5, { width: 40 });
          pdf.y = y;
          write(it.text, PAGE.left + 44, W - 44, false, 10.5);
          write(it.note, PAGE.left + 44, W - 44, false, 9, C.soft);
          originLine(it, PAGE.left + 44, W - 44);
          pdf.y += 8;
        }
        break;
      }
      case 'modules': {
        const hw = 46;
        const tw = 150;
        const titleW = W - hw - tw - 16;
        const rowH = (c: { title: string; tags: string[] }) => Math.max(hOf(c.title, titleW, false, 9.5), hOf(c.tags.join(' · '), tw, false, 8.5)) + 9;
        for (const md of b.modules) {
          const headH = hOf(md.title, W - hw - 20, true, 10.5) + 12;
          const total = headH + md.chapters.reduce((a, c) => a + rowH(c), 0) + (md.exam ? 22 : 0) + 6;
          // El módulo no se corta si cabe entero en una página; si no cabe, al menos el encabezado y dos filas juntos.
          if (pdf.y + total > bottom() && total <= bottom() - PAGE.top) newPage();
          else ensure(headH + 2 * 24);
          const drawHead = (cont: boolean) => {
            const y = pdf.y;
            const hh = hOf(md.title + (cont ? ' (continuación)' : ''), W - hw - 20, true, 10.5) + 12;
            pdf.rect(PAGE.left, y, W, hh).fill(C.fill);
            font(true, 10.5, C.ink); pdf.text(T(md.title + (cont ? ' (continuación)' : '')), PAGE.left + 10, y + 6, { width: W - hw - 20, lineGap: 2 });
            font(true, 10, C.ink); pdf.text(T(md.hours), PAGE.left + W - hw - 8, y + 6, { width: hw, align: 'right' });
            pdf.y = y + hh;
          };
          drawHead(false);
          for (const c of md.chapters) {
            const rh = rowH(c);
            if (pdf.y + rh > bottom()) { newPage(); drawHead(true); }
            const y = pdf.y + 4;
            font(false, 9.5, c.practice ? C.soft : C.ink); pdf.text(T(`${c.n}. ${c.title}`), PAGE.left + 10, y, { width: titleW, lineGap: 2 });
            font(false, 8.5, C.soft); pdf.text(T(c.tags.join(' · ')), PAGE.left + 16 + titleW, y + 0.5, { width: tw, lineGap: 2 });
            font(false, 9.5, C.ink); pdf.text(T(c.hours), PAGE.left + W - hw - 8, y, { width: hw, align: 'right' });
            pdf.y = y - 4 + rh;
            pdf.moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + W, pdf.y).lineWidth(0.4).strokeColor(C.line).stroke();
          }
          if (md.exam) {
            if (pdf.y + 22 > bottom()) newPage();
            const y = pdf.y + 5;
            font(true, 9, C.accent); pdf.text(T('Evaluación del módulo'), PAGE.left + 10, y, { width: W - 20 });
            pdf.y = y + 17;
          }
          pdf.y += 10;
        }
        ensure(hOf(b.footnote, W, false, 8.5) + 4);
        write(b.footnote, PAGE.left, W, false, 8.5, C.soft);
        originLine({ origin: b.origin }, PAGE.left, W);
        break;
      }
      case 'matrix': {
        if (!b.rows.length) { ensure(20); write(b.empty, PAGE.left, W, false, 10, C.soft); break; }
        const lab = 60;
        const cw = Math.min(70, (W - lab) / Math.max(1, b.columns.length));
        const head = () => {
          const y = pdf.y;
          pdf.rect(PAGE.left, y, lab + cw * b.columns.length, 20).fill(C.fill);
          font(true, 8, C.soft); pdf.text(T(b.rowHeader), PAGE.left + 6, y + 6, { width: lab - 8, lineBreak: false });
          b.columns.forEach((c, i) => pdf.text(T(c), PAGE.left + lab + i * cw, y + 6, { width: cw, align: 'center', lineBreak: false }));
          pdf.y = y + 20;
        };
        ensure(20 + 18 * Math.min(3, b.rows.length));
        head();
        for (const r of b.rows) {
          if (pdf.y + 18 > bottom()) { newPage(); head(); }
          const y = pdf.y;
          font(true, 9, C.ink); pdf.text(T(r.label), PAGE.left + 6, y + 5, { width: lab - 8, lineBreak: false });
          r.cells.forEach((on, i) => { font(on, on ? 11 : 9, on ? C.accent : C.faint); pdf.text(on ? '•' : '-', PAGE.left + lab + i * cw, y + (on ? 3 : 5), { width: cw, align: 'center', lineBreak: false }); });
          pdf.y = y + 18;
          pdf.moveTo(PAGE.left, pdf.y).lineTo(PAGE.left + lab + cw * b.columns.length, pdf.y).lineWidth(0.4).strokeColor(C.line).stroke();
        }
        pdf.y += 4;
        break;
      }
      case 'requirements': {
        // LOOP 9.2 (review I2): la columna del estado mide lo que ocupa el rótulo más largo («EXCEPCIÓN ACEPTADA»).
        font(true, 7.5, C.soft);
        const sw = Math.max(92, ...b.items.map((x) => pdf.widthOfString(T(x.statusLabel.toUpperCase()), { characterSpacing: 0.5 }) + 18));
        for (const it of b.items) {
          const h = hOf(it.text, W - sw, false, 10) + (it.note ? hOf(it.note, W - sw, false, 9) : 0) + (it.evidence ? originH({ evidence: it.evidence }, W - sw) : 0) + 10;
          ensure(h);
          const y = pdf.y;
          // «No cubierto» (sin la aceptación de la institución) bloquea: se ve como un conflicto, no como una excepción.
          const blocking = it.status === 'conflict' || it.statusLabel === 'No cubierto';
          const col = it.status === 'met' ? C.ok : blocking ? C.crit : it.status === 'exception' ? C.warn : C.soft;
          const bg = it.status === 'met' ? C.okSoft : blocking ? C.critSoft : it.status === 'exception' ? C.warnSoft : C.fill;
          font(true, 7.5, col);
          const pw = pdf.widthOfString(T(it.statusLabel.toUpperCase()), { characterSpacing: 0.5 }) + 10;
          pdf.roundedRect(PAGE.left, y, pw, 13, 6).fill(bg);
          font(true, 7.5, col); pdf.text(T(it.statusLabel.toUpperCase()), PAGE.left + 5, y + 3, { width: pw, characterSpacing: 0.5, lineBreak: false });
          pdf.y = y;
          write(it.text, PAGE.left + sw, W - sw, false, 10);
          if (it.note) write(it.note, PAGE.left + sw, W - sw, false, 9, C.soft);
          if (it.evidence) originLine({ evidence: it.evidence }, PAGE.left + sw, W - sw);
          pdf.y += 7;
        }
        break;
      }
      case 'exceptions': {
        const lw3 = 132;
        for (const e of b.items) {
          const est = e.rows.reduce((a, r) => a + hOf(r.value, W - lw3 - 24, !!r.strong, 10) + 4, 0) + 20;
          ensure(est);
          const y = pdf.y;
          pdf.y = y + 10;
          for (const r of e.rows) {
            const ry = pdf.y;
            font(true, 8, C.warn); pdf.text(T(r.label.toUpperCase()), PAGE.left + 12, ry + 1, { width: lw3 - 12, characterSpacing: 0.5 });
            pdf.y = ry;
            write(r.value, PAGE.left + lw3, W - lw3 - 24, !!r.strong, 10);
            pdf.y += 4;
          }
          const h = pdf.y - y + 6;
          pdf.roundedRect(PAGE.left, y, W, h, 4).lineWidth(0.8).strokeColor(C.warn).stroke();
          pdf.y = y + h + 8;
        }
        break;
      }
      case 'callout': {
        const h = hOf(b.text, W - 24, true, 10) + 16;
        ensure(h);
        const y = pdf.y;
        pdf.rect(PAGE.left, y, W, h).fill(b.tone === 'warn' ? C.warnSoft : C.accentSoft);
        font(true, 10, b.tone === 'warn' ? C.warn : C.accent); pdf.text(T(b.text), PAGE.left + 12, y + 8, { width: W - 24, lineGap: 2 });
        pdf.y = y + h;
        break;
      }
      case 'legend': {
        ensure(30);
        write(b.title, PAGE.left, W, true, 9, C.soft);
        pdf.y += 2;
        for (const it of b.items) {
          const h = hOf(it.text, W - 150, false, 8.5) + 3;
          ensure(h);
          const y = pdf.y;
          font(true, 7.5, ORIGIN_COLOR[it.key] || C.faint); pdf.text(T(it.label.toUpperCase()), PAGE.left, y + 1, { width: 146, characterSpacing: 0.4 });
          pdf.y = y;
          write(it.text, PAGE.left + 150, W - 150, false, 8.5, C.soft);
          pdf.y += 1;
        }
        break;
      }
    }
  }

  function drawState() {
    const lines = approvalStateTexts(meta);
    const approved = meta.status === 'approved';
    const col = statusColor(meta.status);
    const h = 26 + lines.slice(1).reduce((a, l) => a + hOf(l, W - 40, false, 10) + 3, 0) + (approved ? 14 : 4);
    ensure(h + 10);
    pdf.y += 6;
    const y = pdf.y;
    pdf.y = y + 12;
    write(lines[0], PAGE.left + 20, W - 40, true, 12, col, { characterSpacing: 1.2 });
    pdf.y += 2;
    lines.slice(1).forEach((l, i, arr) => {
      // Aprobado: una línea de firma visual antes de la nota (no es una firma electrónica legal).
      if (approved && i === arr.length - 1) { pdf.y += 8; pdf.moveTo(PAGE.left + 20, pdf.y).lineTo(PAGE.left + 240, pdf.y).lineWidth(0.6).strokeColor(C.faint).stroke(); pdf.y += 4; write(l, PAGE.left + 20, W - 40, false, 8.5, C.soft); return; }
      write(l, PAGE.left + 20, W - 40, false, 10, C.ink); pdf.y += 1;
    });
    const hh = pdf.y - y + 10;
    pdf.roundedRect(PAGE.left, y, W, hh, 6).lineWidth(approved ? 1.5 : 1).strokeColor(col).stroke();
    pdf.y = y + hh + 6;
  }

  // ── encabezado, pie y marcas en todas las páginas ──
  const range = pdf.bufferedPageRange();
  const vtxt = meta.version !== null ? `Propuesta v${meta.version}` : 'Borrador';
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const keepB = pdf.page.margins.bottom;
    const keepT = pdf.page.margins.top;
    pdf.page.margins.bottom = 0;
    pdf.page.margins.top = 0;
    if (meta.status === 'invalidated') pdf.rect(0, 0, PAGE.w, 8).fill(C.crit);
    if (i > range.start) {
      font(false, 8, C.soft);
      // Encabezado en UNA línea: el título largo se acorta (con «…») para que nunca se monte sobre la regla.
      let head = T(`${document.cover.title} · ${vtxt}`);
      if (pdf.widthOfString(head) > W - 170) {
        let t = T(document.cover.title);
        while (t.length > 8 && pdf.widthOfString(`${t}… · ${vtxt}`) > W - 170) t = t.slice(0, -1).trimEnd();
        head = `${t}… · ${vtxt}`;
      }
      pdf.text(head, PAGE.left, 40, { width: W - 160, lineBreak: false });
      font(true, 8, statusColor(meta.status));
      pdf.text(T(STATUS_LABEL[meta.status].toUpperCase()), PAGE.left + W - 160, 40, { width: 160, align: 'right', lineBreak: false, characterSpacing: 0.5 });
      pdf.moveTo(PAGE.left, 54).lineTo(PAGE.left + W, 54).lineWidth(0.5).strokeColor(C.line).stroke();
    }
    pdf.moveTo(PAGE.left, PAGE.h - 48).lineTo(PAGE.left + W, PAGE.h - 48).lineWidth(0.5).strokeColor(C.line).stroke();
    font(false, 8, C.soft);
    const left = [meta.version !== null ? `Versión ${meta.version}` : 'Borrador', meta.date ? formatDateEs(meta.date) : '', `Código de verificación ${meta.fingerprint.slice(0, 8)}`].filter(Boolean).join(' · ');
    pdf.text(T(left), PAGE.left, PAGE.h - 40, { width: W - 120, lineBreak: false });
    pdf.text(T(`Página ${i - range.start + 1} de ${range.count}`), PAGE.left + W - 120, PAGE.h - 40, { width: 120, align: 'right', lineBreak: false });
    if (meta.status === 'draft' || meta.status === 'invalidated') {
      pdf.save();
      pdf.rotate(-32, { origin: [PAGE.w / 2, PAGE.h / 2] });
      pdf.font('Helvetica-Bold').fontSize(64).fillColor(meta.status === 'draft' ? '#5B6573' : '#A3222B').fillOpacity(meta.status === 'draft' ? 0.08 : 0.07);
      pdf.text(meta.status === 'draft' ? 'BORRADOR' : 'NO VIGENTE', 0, PAGE.h / 2 - 32, { width: PAGE.w, align: 'center', lineBreak: false });
      pdf.restore();
      pdf.fillOpacity(1);
    }
    pdf.page.margins.bottom = keepB;
    pdf.page.margins.top = keepT;
  }
  if (pdf.bufferedPageRange().count !== range.count) throw new Error(`PREBRIEF_PDF_FAILED: el pie agregó páginas (${range.count} → ${pdf.bufferedPageRange().count})`);
  pdf.end();
  await done;
  return { pdf: Buffer.concat(chunks), pages: range.count };
}

function statusColor(s: PrebriefDocumentMeta['status']): string {
  return s === 'approved' ? C.ok : s === 'ready' ? C.accent : s === 'changes_requested' ? C.warn : s === 'invalidated' ? C.crit : C.soft;
}
