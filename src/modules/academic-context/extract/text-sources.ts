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
    const kept = dropRepeatedPageFurniture(lines, res.pages.length);
    const dropped = lines.length - kept.length;
    return {
      mediaType: 'application/pdf', lines: kept, pages: res.pages.length, characters,
      ...(dropped ? { notes: [{ code: 'PAGE_FURNITURE_DROPPED', message: `Se descartaron ${dropped} línea(s) que parecen encabezados, pies o números de página del PDF.` }] } : {}),
    };
  } catch (err) {
    throw new DocumentReadError('DOCUMENT_UNREADABLE', `No se pudo leer el PDF (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
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
  const pagesBy = new Map<string, Set<number>>();
  for (const l of lines) {
    if (!edge.has(l) || bullet.test(l.text) || l.text.length > 120) continue;
    const k = l.text.toLowerCase();
    if (!pagesBy.has(k)) pagesBy.set(k, new Set());
    pagesBy.get(k)!.add(l.page ?? 0);
  }
  const need = Math.max(2, Math.ceil(pages / 2));
  return lines.filter((l) => {
    if (pageNum(l)) return false;
    if (pages < 2 || !edge.has(l) || bullet.test(l.text)) return true;
    const set = pagesBy.get(l.text.toLowerCase());
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
