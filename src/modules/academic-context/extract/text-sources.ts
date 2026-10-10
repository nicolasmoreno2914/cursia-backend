import * as JSZip from 'jszip';
import type { AcademicDocument } from '../academic-context';

/**
 * Lectura de documentos académicos → líneas de texto con su ubicación. Sin OCR, sin red, sin proveedores.
 *   - PDF con texto: `pdf-parse` página por página (un PDF escaneado no trae texto → 0 líneas, se informa).
 *   - DOCX: párrafos y filas de tabla de `word/document.xml` (celdas unidas con « | »); los párrafos con estilo de
 *     título o numeración de lista se marcan.
 *   - TXT / MD: línea por línea (los «#» de Markdown marcan títulos).
 */

export interface SourceLine {
  text: string;
  page: number | null;
  /** 1-based dentro del documento (DOCX: n.º de párrafo/fila). */
  line: number;
  /** El documento lo marca como título (estilo Heading / «#» de Markdown). */
  heading?: boolean;
  /** Elemento de una lista numerada o con viñetas del documento. */
  list?: boolean;
  /** Fila de una tabla: celdas en `cells`. */
  cells?: string[];
  /** PDF: el texto llega al borde de la página (el documento lo muestra cortado): hay que confirmarlo. */
  clipped?: boolean;
}

export interface ReadDocument {
  mediaType: AcademicDocument['mediaType'];
  lines: SourceLine[];
  pages: number | null;
  characters: number;
  /** Avisos de lectura (líneas descartadas como encabezado/pie, codificación supuesta…) para el docente. */
  notes?: { code: string; message: string }[];
}

/** Tope del XML descomprimido de un DOCX (defensa contra zip bombs: el archivo comprimido ya está acotado). */
export const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;

/**
 * LOOP 8.6B · 25 MB por documento (antes 7 MB). Lo pesado de los documentos reales son imágenes y fuentes (el texto
 * útil pesa KB): los DOCX llegan ya sin ellas (el navegador las quita antes de subir) y los PDF se leen sin decodificar
 * imágenes. Lo que consume memoria al leer un PDF son las PÁGINAS, por eso además hay un tope de páginas.
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** Páginas máximas de un PDF (se cuentan antes de leer el texto: unos ms y poca memoria). */
export const MAX_PDF_PAGES = 600;

export class DocumentReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Tipo por firma del contenido (no se confía en la extensión): %PDF, zip con word/document.xml, texto UTF-8. */
export function sniffMediaType(buf: Buffer, name: string): AcademicDocument['mediaType'] | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return DOCX;
  // Texto: UTF-8 o Windows-1252 (habitual en sílabos guardados en Windows). Binario → no soportado (review N3): bytes
  // de control C0 (salvo tab/saltos) o bytes que Windows-1252 no define, en más del 0,5 % del archivo. Los bytes
  // «no definidos» solo cuentan en líneas que NO son UTF-8 válido (review I8): en UTF-8 son bytes de continuación
  // legítimos (Á = C3 81, Í = C3 8D, ” = E2 80 9D).
  // Una sola pasada lineal (review I9: decodificar línea por línea bloqueaba segundos con miles de líneas cortas).
  const limit = Math.max(0, buf.length * 0.005);
  let bad = 0;
  let lineUndefined = 0; // bytes «no definidos» de la línea en curso
  let lineValid = true; // ¿la línea en curso es UTF-8 válido hasta aquí?
  let need = 0; // bytes de continuación UTF-8 pendientes
  const endLine = () => {
    if (need) lineValid = false;
    if (!lineValid) bad += lineUndefined;
    lineUndefined = 0; lineValid = true; need = 0;
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0a) { endLine(); if (bad > limit) return null; continue; }
    if ((b < 0x20 && b !== 0x09 && b !== 0x0d && b !== 0x0c) || b === 0x7f) bad++;
    if (CP1252_UNDEFINED.has(b)) lineUndefined++;
    if (!lineValid) continue;
    if (need) {
      if ((b & 0xc0) === 0x80) need--;
      else lineValid = false;
    } else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else if (b >= 0x80) lineValid = false;
  }
  endLine();
  if (bad > limit) return null;
  return /\.md$/i.test(name) ? 'text/markdown' : 'text/plain';
}

/** Bytes 0x80–0x9F que Windows-1252 no define. */
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
/** Windows-1252 0x80–0x9F (comillas tipográficas, rayas, €…); el resto coincide con Latin-1. */
const CP1252_HIGH: Record<number, string> = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6',
  0x89: '\u2030', 0x8a: '\u0160', 0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017D', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C',
  0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02DC', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203A',
  0x9c: '\u0153', 0x9e: '\u017E', 0x9f: '\u0178',
};
export function decodeCp1252(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b] ?? '') : String.fromCharCode(b);
  return out;
}

const collapse = (s: string) => s.replace(/[\u00A0\t ]+/g, ' ').replace(/\s+/g, ' ').trim();

export async function readPdf(buf: Buffer): Promise<ReadDocument> {
  // Import perezoso: pdf-parse carga pdf.js (pesado); solo se paga al leer un PDF.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  let total = 0;
  try {
    total = (await parser.getInfo()).total;
  } catch (err) {
    await parser.destroy().catch(() => undefined);
    throw new DocumentReadError('DOCUMENT_UNREADABLE', `No se pudo leer el PDF (${err instanceof Error ? err.message : String(err)})`);
  }
  if (total > MAX_PDF_PAGES) {
    await parser.destroy().catch(() => undefined);
    throw new DocumentReadError('DOCUMENT_TOO_MANY_PAGES', `el PDF tiene ${total} páginas; Cursia lee hasta ${MAX_PDF_PAGES}. Sube solo las páginas del microcurrículo.`);
  }
  try {
    let lines: SourceLine[];
    let pages: number;
    // Lectura por POSICIÓN (columnas de tablas, títulos por tamaño de letra, texto que sale de la página). Si pdf.js no
    // entrega posiciones utilizables, la lectura de texto plana de siempre.
    const positional = await readPdfPositional(parser, total).catch(() => null);
    if (positional && positional.lines.length) {
      lines = positional.lines;
      pages = positional.pages;
    } else {
      const res = await parser.getText();
      lines = [];
      let n = 0;
      res.pages.forEach((p: { text: string; num?: number }, i: number) => {
        for (const raw of String(p.text || '').split(/\r?\n/)) {
          const text = collapse(stripMarkupTags(raw));
          if (!text) continue;
          n++;
          const cells = (text.match(/ \| /g) || []).length >= 2 ? text.split(' | ').map(collapse) : undefined;
          lines.push({ text, page: typeof p.num === 'number' ? p.num : i + 1, line: n, ...(cells ? { cells } : {}) });
        }
      });
      pages = res.pages.length;
    }
    const characters = lines.reduce((a, l) => a + l.text.length, 0);
    const kept = dropRepeatedPageFurniture(lines, pages);
    const dropped = lines.length - kept.length;
    return {
      mediaType: 'application/pdf', lines: kept, pages, characters,
      ...(dropped ? { notes: [{ code: 'PAGE_FURNITURE_DROPPED', message: `Se descartaron ${dropped} línea(s) que parecen encabezados, pies o números de página del PDF.` }] } : {}),
    };
  } catch (err) {
    throw new DocumentReadError('DOCUMENT_UNREADABLE', `No se pudo leer el PDF (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Etiquetas de marcado que algunos generadores dejan como texto literal («<b>Actividad…</b>»): no son contenido.
 * Solo etiquetas de formato en línea conocidas (nunca «<» sueltos como «< 5 %»).
 */
export function stripMarkupTags(s: string): string {
  return s.replace(/<\/?(?:b|i|u|em|strong|span|small|sup|sub|font|mark)\b[^<>]{0,80}>|<br\s*\/?>/gi, ' ');
}

interface PdfItem { str: string; x: number; y: number; w: number; size: number }

/** Distancia horizontal (pt) entre dos textos de una misma línea a partir de la cual son celdas distintas. */
const PDF_CELL_GAP = 8;

/**
 * Lectura de un PDF por posición del texto (pdf.js): reconstruye lo que la lectura plana pierde en documentos reales.
 *   - Líneas: textos a la misma altura, de izquierda a derecha.
 *   - Celdas: un hueco horizontal grande separa celdas («Capítulo | Contenido | Recursos»). Una celda que DESBORDA sobre
 *     la columna siguiente (el PDF dibuja «…en salud2 videos») se parte en el borde de la columna, que se conoce porque
 *     otras filas de la misma página empiezan exactamente ahí.
 *   - Títulos: letra claramente más grande que la del cuerpo y línea corta.
 *   - Texto cortado: si el texto llega al borde de la página, el documento lo muestra cortado (`clipped`).
 */
async function readPdfPositional(parser: any, total: number): Promise<{ lines: SourceLine[]; pages: number } | null> {
  const doc = await parser.load();
  const out: SourceLine[] = [];
  let n = 0;
  const pageItems: { items: PdfItem[]; width: number }[] = [];
  for (let p = 1; p <= total; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const it of tc.items as any[]) {
      if (!it || typeof it.str !== 'string' || !it.transform) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 0;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, size });
    }
    pageItems.push({ items, width: vp.width });
    page.cleanup?.();
  }
  // Tamaño de letra del cuerpo: el más frecuente (ponderado por caracteres) en todo el documento.
  const bySize = new Map<number, number>();
  for (const pg of pageItems) for (const it of pg.items) if (it.str.trim()) bySize.set(Math.round(it.size * 2) / 2, (bySize.get(Math.round(it.size * 2) / 2) || 0) + it.str.trim().length);
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;

  pageItems.forEach((pg, pi) => {
    const rows = pdfRows(pg.items);
    const rowCells = rows.map((r) => pdfCells(r));
    // Bordes de columna POR TABLA (filas seguidas de ≥ 2 celdas): x donde empieza una celda que no es la primera,
    // repetido en ≥ 2 filas de esa tabla. Una tabla nunca usa los bordes de otra (ni del pie de página).
    const anchorsOf: number[][] = rowCells.map(() => []);
    for (let i = 0; i < rowCells.length;) {
      if (rowCells[i].length < 2) { i++; continue; }
      let j = i;
      while (j < rowCells.length && rowCells[j].length >= 2) j++;
      const starts = new Map<number, number>();
      for (let k = i; k < j; k++) {
        for (const c of rowCells[k].slice(1)) starts.set(Math.round(c.x), (starts.get(Math.round(c.x)) || 0) + 1);
      }
      const anchors = [...starts.entries()].filter(([, c]) => c >= 2).map(([x]) => x).sort((a, b) => a - b);
      for (let k = i; k < j; k++) anchorsOf[k] = anchors;
      i = j;
    }
    // Celda partida en varias líneas: la línea siguiente de una fila de tabla, MÁS CERCA que el paso entre filas
    // (< 1,7 × la letra), que empieza en una columna posterior a la primera y cuyas celdas caen en bordes de esa tabla,
    // es la continuación de esa fila: su texto se suma a la celda de su columna.
    for (let k = 1; k < rowCells.length; k++) {
      const pr = k - 1;
      if (rowCells[pr].length < 2 || !anchorsOf[pr].length || !rowCells[k].length) continue;
      const prevY = Math.min(...rows[pr].map((it) => it.y));
      const y = Math.max(...rows[k].map((it) => it.y));
      const size = Math.max(...rows[pr].map((it) => it.size || 8));
      const first = rowCells[pr][0].x;
      const cont = rowCells[k];
      const onAnchor = (x: number) => anchorsOf[pr].some((a) => Math.abs(a - x) <= 3);
      if (prevY - y >= size * 1.7 || cont[0].x <= first + 4 || !cont.every((c) => onAnchor(c.x))) continue;
      for (const c of cont) {
        const target = [...rowCells[pr]].reverse().find((p) => p.x <= c.x + 4);
        if (target) { target.text = `${target.text.replace(/\s+$/, '')} ${c.text.replace(/^\s+/, '')}`; target.end = Math.max(target.end, c.end); }
      }
      rows[pr].push(...rows[k]);
      rows.splice(k, 1);
      rowCells.splice(k, 1);
      anchorsOf.splice(k, 1);
      k--;
    }
    rowCells.forEach((cells0, ri) => {
      const cells = cells0.length >= 2 ? splitOverflow(cells0, anchorsOf[ri]) : cells0;
      const texts = cells.map((c) => collapse(stripMarkupTags(c.text))).filter(Boolean);
      if (!texts.length) return;
      const items = rows[ri].filter((it) => it.str.trim());
      const clipped = items.some((it) => it.w > 0 && it.x + it.w > pg.width - 0.5);
      const size = Math.max(...items.map((it) => it.size));
      const text = texts.join(texts.length >= 2 ? ' | ' : ' ');
      const words = text.split(/\s+/).length;
      const heading = texts.length === 1 && body > 0 && size >= body * 1.18 && words <= 14 && !/[.;,]$/.test(text);
      n++;
      out.push({ text, page: pi + 1, line: n, ...(texts.length >= 2 ? { cells: texts } : {}), ...(heading ? { heading: true } : {}), ...(clipped ? { clipped: true } : {}) });
    });
  });
  return { lines: out, pages: total };
}

/** Agrupa los textos de una página en filas (misma altura) de arriba hacia abajo, cada fila de izquierda a derecha. */
function pdfRows(items: PdfItem[]): PdfItem[][] {
  const sorted = items.filter((it) => it.str.length).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { y: number; tol: number; items: PdfItem[] }[] = [];
  for (const it of sorted) {
    const tol = Math.max(2, (it.size || 8) * 0.45);
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(tol, r.tol));
    if (row && it.str.trim()) row.items.push(it);
    else if (it.str.trim()) rows.push({ y: it.y, tol, items: [it] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x));
}

/** Celdas de una fila: un hueco horizontal ≥ PDF_CELL_GAP (o ≥ 1,2 × el tamaño de letra) abre una celda nueva. */
function pdfCells(row: PdfItem[]): { x: number; end: number; text: string; items: PdfItem[] }[] {
  const cells: { x: number; end: number; text: string; items: PdfItem[] }[] = [];
  for (const it of row) {
    const cur = cells[cells.length - 1];
    const gap = cur ? it.x - cur.end : Infinity;
    if (cur && gap < Math.max(PDF_CELL_GAP, (it.size || 8) * 1.2)) {
      cur.text += (gap > (it.size || 8) * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
      cur.end = Math.max(cur.end, it.x + it.w);
      cur.items.push(it);
    } else {
      cells.push({ x: it.x, end: it.x + it.w, text: it.str, items: [it] });
    }
  }
  return cells;
}

/**
 * Una celda que empieza antes de un borde de columna y lo cruza desbordó sobre la celda vecina: se parte en el carácter
 * que cae en el borde (ancho medio por carácter), ajustado al cambio de palabra más cercano (espacio, letra→número,
 * minúscula→mayúscula). Solo en filas de tabla (≥ 2 celdas); un párrafo nunca se parte.
 */
function splitOverflow(cells: { x: number; end: number; text: string; items: PdfItem[] }[], anchors: number[]) {
  const out: typeof cells = [];
  for (const c of cells) {
    const a = anchors.find((x) => x > c.x + 4 && x < c.end - 4);
    if (a === undefined || c.text.length < 4) { out.push(c); continue; }
    const per = (c.end - c.x) / c.text.length;
    const est = Math.round((a - c.x) / per);
    // Primero un corte FUERTE (dos textos pegados: «salud2 videos», «saludRecursos») cerca de la estimación (el ancho por
    // carácter de una letra proporcional varía); si no hay, el espacio más cercano.
    const pick = (span: number, strong: boolean) => {
      let at = -1;
      let score = Infinity;
      for (let i = Math.max(1, est - span); i <= Math.min(c.text.length - 1, est + span); i++) {
        const prev = c.text[i - 1];
        const ch = c.text[i];
        const hit = strong
          ? (/[a-záéíóúñ.)]/i.test(prev) && /\d/.test(ch)) || (/[a-záéíóúñ]/.test(prev) && /[A-ZÁÉÍÓÚÑ]/.test(ch))
          : /\s/.test(prev) && /\S/.test(ch);
        if (hit && Math.abs(i - est) < score) { at = i; score = Math.abs(i - est); }
      }
      return at;
    };
    let best = pick(Math.max(12, Math.round(c.text.length * 0.25)), true);
    if (best < 0) best = pick(8, false);
    if (best < 0) { out.push(c); continue; }
    out.push({ x: c.x, end: a, text: c.text.slice(0, best), items: c.items });
    out.push({ x: a, end: c.end, text: c.text.slice(best), items: c.items });
  }
  return out;
}

/**
 * Encabezados / pies de página: SOLO entre las 2 primeras y las 2 últimas líneas de cada página, que no sean viñetas,
 * y que se repitan (mismo texto) en ≥ 50 % de las páginas (mínimo 2). Un número suelto es número de página solo si es
 * la primera o la última línea de su página y coincide con su número («3», «Página 3», «3 de 10»). Nada del cuerpo de
 * la página se descarta (un tema repetido en dos unidades o el «64» debajo de «Total de horas» se conservan).
 */
export function dropRepeatedPageFurniture(lines: SourceLine[], pages: number): SourceLine[] {
  const byPage = new Map<number, SourceLine[]>();
  for (const l of lines) {
    const p = l.page ?? 0;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p)!.push(l);
  }
  const edge = new Set<SourceLine>();
  const firstLast = new Set<SourceLine>();
  for (const ls of byPage.values()) {
    ls.slice(0, 2).forEach((l) => edge.add(l));
    ls.slice(-2).forEach((l) => edge.add(l));
    firstLast.add(ls[0]);
    firstLast.add(ls[ls.length - 1]);
  }
  const bullet = /^\s*(?:[-•*▪◦○●·–—]|\(?[0-9]{1,2}[.)])\s+/;
  const pageNum = (l: SourceLine) => {
    const m = /^(?:p[aá]g(?:ina)?\.?\s*)?(\d{1,4})(?:\s*(?:de|\/)\s*\d{1,4})?$/i.exec(l.text);
    return !!m && firstLast.has(l) && Number(m[1]) === l.page;
  };
  // El número de página cambia en cada página («Curso X · Página 3», «3 de 10»): se compara sin él. Solo el número que
  // acompaña a «página» o a «de N», o el que cierra/abre la línea separado del resto (nunca cifras del cuerpo).
  const furnitureKey = (t: string) =>
    t.toLowerCase()
      .replace(/\bp[aá]g(?:ina)?\.?\s*\d{1,4}(?:\s*(?:de|\/)\s*\d{1,4})?/g, 'página #')
      .replace(/\b\d{1,4}\s*(?:de|\/)\s*\d{1,4}\b/g, '# de #')
      .replace(/(?:^|\s[|·—–-]\s|\s{2,})\d{1,4}$/, ' #')
      .replace(/^\d{1,4}(?:\s[|·—–-]\s|\s{2,})/, '# ');
  const pagesBy = new Map<string, Set<number>>();
  for (const l of lines) {
    if (!edge.has(l) || bullet.test(l.text) || l.text.length > 120) continue;
    const k = furnitureKey(l.text);
    if (!pagesBy.has(k)) pagesBy.set(k, new Set());
    pagesBy.get(k)!.add(l.page ?? 0);
  }
  const need = Math.max(2, Math.ceil(pages / 2));
  return lines.filter((l) => {
    if (pageNum(l)) return false;
    if (pages < 2 || !edge.has(l) || bullet.test(l.text)) return true;
    const set = pagesBy.get(furnitureKey(l.text));
    return !set || set.size < need;
  });
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Texto de un fragmento de WordprocessingML: <w:t>, tabulaciones y saltos. */
function runText(xml: string): string {
  let out = '';
  const re = /<w:(t|tab|br|cr)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1] === 't') out += decodeXml(m[2] ?? '');
    else out += ' ';
  }
  return out;
}

/** Descomprime una entrada del ZIP en streaming, con tope de bytes REALES (no el declarado). */
function inflateLimited(file: JSZip.JSZipObject, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const h = (file as any).internalStream('uint8array');
    h.on('data', (chunk: Uint8Array) => {
      if (done) return;
      total += chunk.length;
      if (total > max) {
        done = true;
        try { h.pause(); } catch { /* ya detenido */ }
        reject(new DocumentReadError('DOCUMENT_TOO_LARGE', `el contenido del DOCX descomprimido supera ${max / 1024 / 1024} MB`));
        return;
      }
      chunks.push(chunk);
    })
      .on('error', (e: unknown) => { if (!done) { done = true; reject(e); } })
      .on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')); } })
      .resume();
  });
}

export async function readDocx(buf: Buffer): Promise<ReadDocument> {
  let xml: string;
  try {
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('falta word/document.xml');
    // Zip bomb (review I7): el tamaño declarado en el ZIP puede mentir; se descomprime por partes CONTANDO los bytes
    // reales y se corta al pasar el tope (nunca se infla entero en memoria).
    const declared = Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    if (declared > MAX_DOCX_XML_BYTES) throw new DocumentReadError('DOCUMENT_TOO_LARGE', `el contenido del DOCX descomprimido supera ${MAX_DOCX_XML_BYTES / 1024 / 1024} MB`);
    xml = await inflateLimited(f, MAX_DOCX_XML_BYTES);
  } catch (err) {
    if (err instanceof DocumentReadError) throw err;
    throw new DocumentReadError('DOCUMENT_UNREADABLE', `No se pudo leer el DOCX (${err instanceof Error ? err.message : String(err)})`);
  }
  const body = xml.replace(/^[\s\S]*?<w:body>/, '').replace(/<\/w:body>[\s\S]*$/, '');
  const lines: SourceLine[] = [];
  let n = 0;
  let characters = 0;
  const push = (l: Omit<SourceLine, 'line'>) => {
    if (!l.text) return;
    n++;
    characters += l.text.length;
    lines.push({ ...l, line: n });
  };
  // Tablas y párrafos en orden de aparición. Limitación conocida: una tabla ANIDADA corta la tabla exterior en su
  // primer </w:tbl> (el resto de la fila exterior se lee como párrafos sueltos).
  const blockRe = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p\b(?:[^>]*[^/>])?>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body))) {
    if (m[1] !== undefined) {
      const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let r: RegExpExecArray | null;
      while ((r = rowRe.exec(m[1]))) {
        const cells: string[] = [];
        const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let c: RegExpExecArray | null;
        while ((c = cellRe.exec(r[1]))) {
          const paras = [...c[1].matchAll(/<w:p\b(?:[^>]*[^/>])?>([\s\S]*?)<\/w:p>/g)].map((p) => collapse(runText(p[1]))).filter(Boolean);
          cells.push(paras.join('; '));
        }
        const nonEmpty = cells.filter(Boolean);
        if (nonEmpty.length) push({ text: nonEmpty.join(' | '), page: null, cells });
      }
    } else if (m[2] !== undefined) {
      const p = m[2];
      const text = collapse(runText(p));
      const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(p)?.[1] ?? '';
      const heading = /^(heading|t[ií]tulo|ttulo|title)\s*\d*$/i.test(style) || /^Heading\d$/.test(style);
      const list = /<w:numPr>/.test(p) || /^(listparagraph|prrafodelista|p[aá]rrafodelista)$/i.test(style);
      push({ text, page: null, ...(heading ? { heading: true } : {}), ...(list ? { list: true } : {}) });
    }
  }
  return { mediaType: DOCX, lines, pages: null, characters };
}

export function readText(buf: Buffer, mediaType: 'text/plain' | 'text/markdown'): ReadDocument {
  const lines: SourceLine[] = [];
  let n = 0;
  let characters = 0;
  // Línea por línea (review N2): cada línea en UTF-8; solo las que no lo son se leen como Windows-1252 (un byte
  // suelto no arruina las tildes del resto del archivo).
  let latin1 = false;
  const rawLines: string[] = [];
  let startAt = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    const bytes = buf.subarray(startAt, i);
    const u = bytes.toString('utf8');
    if (u.includes('\uFFFD')) { latin1 = true; rawLines.push(decodeCp1252(bytes)); } else rawLines.push(u);
    startAt = i + 1;
  }
  if (rawLines.length) rawLines[0] = rawLines[0].replace(/^\uFEFF/, '');
  for (const rawLine of rawLines) {
    const raw = rawLine.replace(/\r$/, '');
    n++;
    let text = raw;
    let heading = false;
    if (mediaType === 'text/markdown') {
      const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(text);
      if (h) { text = h[1]; heading = true; }
      text = text.replace(/\*\*|__/g, '');
    }
    // Tabla Markdown / texto con barras: celdas.
    let cells: string[] | undefined;
    if (/^\s*\|.*\|\s*$/.test(text)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(text)) continue; // separador |---|
      cells = text.trim().replace(/^\||\|$/g, '').split('|').map(collapse);
      text = cells.filter(Boolean).join(' | ');
    }
    if (!cells && (text.match(/ \| /g) || []).length >= 2) cells = text.split(' | ').map(collapse);
    text = collapse(text);
    if (!text) continue;
    characters += text.length;
    lines.push({ text, page: null, line: n, ...(heading ? { heading: true } : {}), ...(cells ? { cells } : {}) });
  }
  return {
    mediaType, lines, pages: null, characters,
    ...(latin1 ? { notes: [{ code: 'ENCODING_ASSUMED_LATIN1', message: 'Parte del texto no estaba en UTF-8: esas líneas se leyeron como Windows-1252. Revisa las tildes; si se ven mal, guárdalo como UTF-8.' }] } : {}),
  };
}

export async function readDocument(buf: Buffer, name: string): Promise<ReadDocument> {
  if (!buf.length) throw new DocumentReadError('DOCUMENT_EMPTY', `«${name}» está vacío`);
  if (buf.length > MAX_DOCUMENT_BYTES) throw new DocumentReadError('DOCUMENT_TOO_LARGE', `«${name}» supera ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
  const type = sniffMediaType(buf, name);
  if (type === 'application/pdf') return readPdf(buf);
  if (type === DOCX) return readDocx(buf);
  if (type === 'text/plain' || type === 'text/markdown') return readText(buf, type);
  throw new DocumentReadError('UNSUPPORTED_DOCUMENT', `«${name}» no es un PDF con texto, DOCX ni texto plano`);
}
