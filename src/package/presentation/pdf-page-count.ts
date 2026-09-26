/**
 * R9 — conteo de páginas de un PDF, puro (sin librerías externas, solo zlib
 * de node para los object streams comprimidos).
 *
 * Estrategia (nunca adivina — ver PdfPageCountUnknownError):
 *  1. Buscar objetos `/Type /Pages` con un `/Count N` cercano en el texto
 *     crudo del archivo (PDFs "clásicos", sin xref streams).
 *  2. Si no hay ninguno (PDFs modernos con object streams, `/Type /ObjStm`),
 *     inflar cada ObjStm con zlib y repetir la búsqueda dentro del contenido
 *     descomprimido.
 *  3. Si tampoco aparece un `/Count` utilizable, contar objetos `/Type /Page`
 *     (no `/Pages`) tanto en el texto crudo como en los streams inflados.
 *  4. Si nada de lo anterior produce un número, lanzar PDF_PAGECOUNT_UNKNOWN.
 *
 * Los 9 PDFs reales de V1 (`cap{N}_presentacion.pdf`, ver
 * scripts/fixtures/v21-presentation-v1-fixtures.json) usan el caso 2:
 * `%PDF-1.7` con todo el árbol de páginas dentro de un `/Type /ObjStm`
 * comprimido con FlateDecode — no hay ningún `/Type /Pages` legible en texto
 * plano en esos archivos.
 */
import { inflateSync } from 'zlib';

export class PdfPageCountUnknownError extends Error {
  readonly code = 'PDF_PAGECOUNT_UNKNOWN';
  constructor(reason: string) {
    super(`PDF_PAGECOUNT_UNKNOWN: ${reason}`);
    this.name = 'PdfPageCountUnknownError';
  }
}

/** buf.toString('latin1') mapea 1 byte -> 1 char: los índices del string resultante
 *  son exactamente offsets de byte en el Buffer original, así que podemos usar
 *  regex sobre el string y volver a cortar el Buffer con los mismos índices. */
function toLatin1(buf: Buffer): string {
  return buf.toString('latin1');
}

function extractPagesCounts(text: string): number[] {
  const counts: number[] = [];
  const re = /\/Type\s*\/Pages\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const winStart = Math.max(0, m.index - 800);
    const winEnd = Math.min(text.length, m.index + 800);
    const win = text.slice(winStart, winEnd);
    const cm = win.match(/\/Count\s+(\d+)/);
    if (cm) counts.push(parseInt(cm[1], 10));
  }
  return counts;
}

function countLeafPageObjects(text: string): number {
  // /Type /Page pero no /Type /Pages (negative lookahead de la "s" final).
  const re = /\/Type\s*\/Page(?!s)\b/g;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

/** Ubica objetos `/Type /ObjStm` (streams de objetos comprimidos, PDF 1.5+),
 * los infla con zlib y devuelve su contenido descomprimido como texto latin1. */
function inflateObjectStreams(buf: Buffer, text: string): string[] {
  const out: string[] = [];
  const objHeaderRe = /\d+[ \t]+\d+[ \t]+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = objHeaderRe.exec(text))) {
    const objStart = m.index;
    const endObjIdx = text.indexOf('endobj', objStart);
    if (endObjIdx === -1) continue;
    const dictAndStream = text.slice(objStart, endObjIdx);
    if (!/\/Type\s*\/ObjStm/.test(dictAndStream)) continue;

    const streamKwRel = dictAndStream.indexOf('stream');
    if (streamKwRel === -1) continue;
    let dataStart = objStart + streamKwRel + 'stream'.length;
    // El keyword "stream" va seguido de CRLF o LF antes de los datos.
    if (text[dataStart] === '\r') dataStart++;
    if (text[dataStart] === '\n') dataStart++;

    const endStreamRel = dictAndStream.indexOf('endstream', streamKwRel);
    if (endStreamRel === -1) continue;
    const dataEnd = objStart + endStreamRel;
    if (dataEnd <= dataStart) continue;

    const rawStream = buf.subarray(dataStart, dataEnd);
    try {
      const inflated = inflateSync(rawStream);
      out.push(inflated.toString('latin1'));
    } catch {
      // No era FlateDecode válido (u otro filtro no soportado) — se ignora
      // este objeto y se sigue con el resto; nunca se adivina un conteo.
    }
  }
  return out;
}

export function pdfPageCount(buf: Buffer): number {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.toString('latin1', 0, 5) !== '%PDF-') {
    throw new PdfPageCountUnknownError('el buffer no empieza con la cabecera %PDF-');
  }
  const text = toLatin1(buf);

  // 1) /Type /Pages con /Count explícito, en texto plano.
  let counts = extractPagesCounts(text);

  // 2) Si no hay ninguno, decodificar los object streams comprimidos y
  //    repetir la búsqueda dentro de su contenido.
  let objStmTexts: string[] | null = null;
  if (counts.length === 0) {
    objStmTexts = inflateObjectStreams(buf, text);
    for (const t of objStmTexts) counts = counts.concat(extractPagesCounts(t));
  }

  if (counts.length > 0) {
    // El nodo raíz del árbol de páginas es el de mayor /Count (los nodos
    // intermedios sólo cubren un subconjunto de las hojas). Tomar el máximo
    // es siempre una cota superior correcta del documento, nunca una
    // adivinanza: si hay un único nodo /Pages (caso normal), es exactamente
    // ese valor.
    return Math.max(...counts);
  }

  // 3) Fallback: contar objetos /Type /Page (no /Pages) directamente, tanto
  //    en texto plano como dentro de los ObjStm ya inflados (o inflándolos
  //    ahora si el paso 2 no se ejecutó porque sí había /Type/Pages sin
  //    /Count legible, caso defensivo).
  let leafCount = countLeafPageObjects(text);
  if (objStmTexts === null) objStmTexts = inflateObjectStreams(buf, text);
  for (const t of objStmTexts) leafCount += countLeafPageObjects(t);

  if (leafCount > 0) return leafCount;

  throw new PdfPageCountUnknownError(
    'no se encontró /Type /Pages con /Count legible ni objetos /Type /Page, ' +
      'ni en texto plano ni en los object streams comprimidos',
  );
}
