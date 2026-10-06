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
}

export interface ReadDocument {
  mediaType: AcademicDocument['mediaType'];
  lines: SourceLine[];
  pages: number | null;
  characters: number;
}

export const MAX_DOCUMENT_BYTES = 7 * 1024 * 1024;

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
  // Texto: UTF-8 válido y sin bytes de control binarios.
  const s = buf.toString('utf8');
  if (s.includes('\uFFFD') || /[\x00-\x08\x0E-\x1F]/.test(s)) return null;
  return /\.md$/i.test(name) ? 'text/markdown' : 'text/plain';
}

const collapse = (s: string) => s.replace(/[\u00A0\t ]+/g, ' ').replace(/\s+/g, ' ').trim();

export async function readPdf(buf: Buffer): Promise<ReadDocument> {
  // Import perezoso: pdf-parse carga pdf.js (pesado); solo se paga al leer un PDF.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    const lines: SourceLine[] = [];
    let n = 0;
    let characters = 0;
    res.pages.forEach((p: { text: string; num?: number }, i: number) => {
      for (const raw of String(p.text || '').split(/\r?\n/)) {
        const text = collapse(raw);
        if (!text) continue;
        n++;
        characters += text.length;
        const cells = (text.match(/ \| /g) || []).length >= 2 ? text.split(' | ').map(collapse) : undefined;
        lines.push({ text, page: typeof p.num === 'number' ? p.num : i + 1, line: n, ...(cells ? { cells } : {}) });
      }
    });
    return { mediaType: 'application/pdf', lines: dropRepeatedPageFurniture(lines, res.pages.length), pages: res.pages.length, characters };
  } catch (err) {
    throw new DocumentReadError('DOCUMENT_UNREADABLE', `No se pudo leer el PDF (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Encabezados / pies repetidos en ≥ 50 % de las páginas (mínimo 2 páginas) y números de página sueltos. */
export function dropRepeatedPageFurniture(lines: SourceLine[], pages: number): SourceLine[] {
  const pageNumRe = /^(?:p[aá]g(?:ina)?\.?\s*)?\d{1,4}(?:\s*(?:de|\/)\s*\d{1,4})?$/i;
  if (pages < 2) return lines.filter((l) => !pageNumRe.test(l.text));
  const pagesBy = new Map<string, Set<number>>();
  for (const l of lines) {
    const k = l.text.toLowerCase();
    if (!pagesBy.has(k)) pagesBy.set(k, new Set());
    pagesBy.get(k)!.add(l.page ?? 0);
  }
  return lines.filter((l) => !pageNumRe.test(l.text) && (pagesBy.get(l.text.toLowerCase())!.size < Math.max(2, Math.ceil(pages / 2)) || l.text.length > 120));
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

export async function readDocx(buf: Buffer): Promise<ReadDocument> {
  let xml: string;
  try {
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('falta word/document.xml');
    xml = await f.async('string');
  } catch (err) {
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
  // Tablas y párrafos en orden de aparición (las tablas anidadas se aplanan en su fila).
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
  for (const raw of buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
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
  return { mediaType, lines, pages: null, characters };
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
