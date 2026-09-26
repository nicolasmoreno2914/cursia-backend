/**
 * R9 — conteo de páginas de un PDF, puro (sin librerías externas, solo zlib
 * de node para los object streams comprimidos).
 *
 * Fix round 1 (review G5, I2/M1) — NUNCA devuelve un número dudoso:
 *  1. Se arma un índice de objetos `N G obj … endobj`: en texto plano y dentro
 *     de cada `/Type /ObjStm` (FlateDecode, inflado con tope de 32 MiB). Si un
 *     objeto aparece varias veces (actualizaciones incrementales) gana la
 *     última aparición en el archivo.
 *  2. Se resuelve la raíz: el ÚLTIMO `trailer` o xref stream (`/Type /XRef`)
 *     con `/Root N G R` → Catálogo (`/Type /Catalog`) → `/Pages N G R` → ese
 *     nodo `/Type /Pages` → su `/Count` de NIVEL SUPERIOR (dentro de su propio
 *     diccionario, nunca un `/Count` de otro objeto cercano como /Outlines).
 *  3. Sin raíz resoluble: solo se acepta si hay EXACTAMENTE un nodo /Pages sin
 *     `/Parent` (la raíz del árbol) en la versión vigente de cada objeto.
 *  4. `/Count` < 1, indirecto (`/Count 5 0 R`), ambigüedad o un stream que
 *     infla más de 32 MiB → PDF_PAGECOUNT_UNKNOWN. Nunca se cuentan hojas ni
 *     se toma un máximo "por las dudas".
 *
 * Los 9 PDFs reales de V1 (Gamma, `%PDF-1.7`) tienen el catálogo y el árbol de
 * páginas dentro de un ObjStm y un xref stream con `/Root`: caso 2.
 */
import { inflateSync } from 'zlib';

export class PdfPageCountUnknownError extends Error {
  readonly code = 'PDF_PAGECOUNT_UNKNOWN';
  constructor(reason: string) {
    super(`PDF_PAGECOUNT_UNKNOWN: ${reason}`);
    this.name = 'PdfPageCountUnknownError';
  }
}

/** Tope de salida de un ObjStm inflado (defensa ante "zip bombs"). */
export const PDF_INFLATE_MAX_BYTES = 32 * 1024 * 1024;

interface PdfObject {
  num: number;
  /** Posición en el archivo (para "gana la última"); dentro de un ObjStm, la del stream + índice. */
  order: number;
  body: string;
}

const WS = ' \t\r\n\f\0';

/** Diccionario `<< … >>` balanceado que empieza en `from` (o el primero después). */
function balancedDict(text: string, from = 0): string | null {
  const start = text.indexOf('<<', from);
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(') {
      // string literal con paréntesis anidados y escapes
      let d = 1;
      i++;
      while (i < text.length && d > 0) {
        if (text[i] === '\\') i += 2;
        else {
          if (text[i] === '(') d++;
          else if (text[i] === ')') d--;
          i++;
        }
      }
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      depth++;
      i += 2;
      continue;
    }
    if (ch === '>' && text[i + 1] === '>') {
      depth--;
      i += 2;
      if (depth === 0) return text.slice(start, i);
      continue;
    }
    if (ch === '<') {
      // hex string
      const end = text.indexOf('>', i + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    i++;
  }
  return null;
}

/** Entradas de NIVEL SUPERIOR de un diccionario (valor crudo, sin normalizar). */
export function topLevelEntries(dict: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 2; // salta "<<"
  const end = dict.length - 2;
  const skipWs = () => {
    while (i < end && WS.includes(dict[i])) i++;
  };
  const readName = (): string => {
    let j = i + 1;
    while (j < end && !WS.includes(dict[j]) && !'/<>[]()'.includes(dict[j])) j++;
    const n = dict.slice(i, j);
    i = j;
    return n;
  };
  const readValue = (): string => {
    skipWs();
    const s = i;
    const ch = dict[i];
    if (ch === '/') return readName();
    if (ch === '<' && dict[i + 1] === '<') {
      const d = balancedDict(dict, i) ?? '';
      i += d.length || 2;
      return d;
    }
    if (ch === '[') {
      let depth = 0;
      while (i < end) {
        if (dict[i] === '[') depth++;
        else if (dict[i] === ']') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      return dict.slice(s, i);
    }
    if (ch === '(') {
      let d = 0;
      while (i < end) {
        if (dict[i] === '\\') {
          i += 2;
          continue;
        }
        if (dict[i] === '(') d++;
        else if (dict[i] === ')') {
          d--;
          if (d === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      return dict.slice(s, i);
    }
    if (ch === '<') {
      const e = dict.indexOf('>', i);
      i = e < 0 ? end : e + 1;
      return dict.slice(s, i);
    }
    // número, referencia "N G R", booleano o null
    const m = /^(\d+\s+\d+\s+R\b|[^\s/<>\[\]()]+)/.exec(dict.slice(i, end));
    if (!m) {
      i++;
      return '';
    }
    i += m[0].length;
    return m[0];
  };
  while (i < end) {
    skipWs();
    if (i >= end) break;
    if (dict[i] !== '/') {
      i++;
      continue;
    }
    const key = readName();
    const value = readValue();
    out.set(key, value.trim());
  }
  return out;
}

function refNum(v: string | undefined): number | null {
  const m = v ? /^(\d+)\s+\d+\s+R$/.exec(v) : null;
  return m ? parseInt(m[1], 10) : null;
}

function inflateBounded(data: Buffer): Buffer | null {
  try {
    return inflateSync(data, { maxOutputLength: PDF_INFLATE_MAX_BYTES });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
      throw new PdfPageCountUnknownError(`un object stream infla más de ${PDF_INFLATE_MAX_BYTES} bytes`);
    }
    return null; // no es FlateDecode válido: se ignora (nunca se adivina)
  }
}

/** Índice de objetos (texto plano + ObjStm) y los diccionarios de trailer/xref en orden de archivo. */
function indexObjects(buf: Buffer): { objects: Map<number, PdfObject>; trailers: Array<{ order: number; dict: string }> } {
  const text = buf.toString('latin1'); // 1 byte = 1 char: índices = offsets
  const all: PdfObject[] = [];
  const trailers: Array<{ order: number; dict: string }> = [];
  const hdr = /(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = hdr.exec(text))) {
    const start = m.index + m[0].length;
    const dict = balancedDict(text, start);
    const nextEndobj = text.indexOf('endobj', start);
    if (nextEndobj < 0) break;
    let bodyEnd = nextEndobj;
    let isStream = false;
    const dictAt = dict ? text.indexOf('<<', start) : -1;
    if (dict && dictAt >= 0 && dictAt < nextEndobj) {
      const after = dictAt + dict.length;
      const sk = /^[\s]*stream(\r\n|\n|\r)/.exec(text.slice(after, after + 16));
      if (sk) {
        isStream = true;
        const dataStart = after + sk[0].length;
        const es = text.indexOf('endstream', dataStart);
        if (es < 0) break;
        const eo = text.indexOf('endobj', es);
        if (eo < 0) break;
        bodyEnd = eo;
        const entries = topLevelEntries(dict);
        if (entries.get('/Type') === '/ObjStm' && (entries.get('/Filter') ?? '').includes('/FlateDecode')) {
          const len = entries.get('/Length') ?? '';
          let dataEnd = es;
          if (/^\d+$/.test(len) && dataStart + parseInt(len, 10) <= es) dataEnd = dataStart + parseInt(len, 10);
          else {
            if (text[dataEnd - 1] === '\n') dataEnd--;
            if (text[dataEnd - 1] === '\r') dataEnd--;
          }
          const inflated = inflateBounded(buf.subarray(dataStart, dataEnd));
          if (inflated) {
            const inner = inflated.toString('latin1');
            const n = parseInt(entries.get('/N') ?? '', 10);
            const first = parseInt(entries.get('/First') ?? '', 10);
            if (Number.isInteger(n) && Number.isInteger(first) && first >= 0 && first <= inner.length) {
              const nums = inner.slice(0, first).trim().split(/\s+/).map((x) => parseInt(x, 10));
              if (nums.length >= 2 * n && nums.every(Number.isInteger)) {
                for (let k = 0; k < n; k++) {
                  const off = first + nums[2 * k + 1];
                  const next = k + 1 < n ? first + nums[2 * k + 3] : inner.length;
                  all.push({ num: nums[2 * k], order: m.index + k / (n + 1), body: inner.slice(off, next) });
                }
              }
            }
          }
        }
        if (entries.get('/Type') === '/XRef') trailers.push({ order: m.index, dict });
      }
    }
    if (!isStream) all.push({ num: parseInt(m[1], 10), order: m.index, body: text.slice(start, bodyEnd) });
    else if (dict) all.push({ num: parseInt(m[1], 10), order: m.index, body: dict });
    hdr.lastIndex = bodyEnd + 'endobj'.length;
  }
  const tr = /trailer\b/g;
  while ((m = tr.exec(text))) {
    const d = balancedDict(text, m.index);
    if (d) trailers.push({ order: m.index, dict: d });
  }
  const objects = new Map<number, PdfObject>();
  for (const o of all.sort((a, b) => a.order - b.order)) objects.set(o.num, o);
  trailers.sort((a, b) => a.order - b.order);
  return { objects, trailers };
}

function pagesCountOf(dictBody: string, where: string): number {
  const d = balancedDict(dictBody);
  if (!d) throw new PdfPageCountUnknownError(`${where}: sin diccionario`);
  const e = topLevelEntries(d);
  if (e.get('/Type') !== '/Pages') throw new PdfPageCountUnknownError(`${where}: no es /Type /Pages`);
  const raw = e.get('/Count');
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new PdfPageCountUnknownError(`${where}: /Count ausente o indirecto (${JSON.stringify(raw)})`);
  }
  const n = parseInt(raw, 10);
  if (n < 1) throw new PdfPageCountUnknownError(`${where}: /Count ${n} < 1`);
  return n;
}

export function pdfPageCount(buf: Buffer): number {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.toString('latin1', 0, 5) !== '%PDF-') {
    throw new PdfPageCountUnknownError('el buffer no empieza con la cabecera %PDF-');
  }
  const { objects, trailers } = indexObjects(buf);

  // 2) Raíz vía el último trailer / xref stream con /Root.
  for (let t = trailers.length - 1; t >= 0; t--) {
    const root = refNum(topLevelEntries(trailers[t].dict).get('/Root'));
    if (root === null) continue;
    const cat = objects.get(root);
    const catDict = cat ? balancedDict(cat.body) : null;
    if (!catDict) throw new PdfPageCountUnknownError(`el catálogo ${root} 0 R no existe`);
    const ce = topLevelEntries(catDict);
    if (ce.get('/Type') !== '/Catalog') throw new PdfPageCountUnknownError(`el objeto ${root} no es /Type /Catalog`);
    const pagesNum = refNum(ce.get('/Pages'));
    const pages = pagesNum === null ? undefined : objects.get(pagesNum);
    if (!pages) throw new PdfPageCountUnknownError('el catálogo no apunta a un nodo /Pages existente');
    return pagesCountOf(pages.body, `nodo /Pages ${pagesNum} 0 R`);
  }

  // 3) Sin raíz: exactamente un nodo /Pages sin /Parent (versión vigente de cada objeto).
  const roots: Array<{ num: number; body: string }> = [];
  for (const o of objects.values()) {
    const d = balancedDict(o.body);
    if (!d) continue;
    const e = topLevelEntries(d);
    if (e.get('/Type') === '/Pages' && !e.has('/Parent')) roots.push({ num: o.num, body: o.body });
  }
  if (roots.length === 1) return pagesCountOf(roots[0].body, `nodo /Pages ${roots[0].num} 0 R`);
  throw new PdfPageCountUnknownError(
    roots.length === 0
      ? 'sin /Root resoluble ni nodo /Pages raíz (ni en texto plano ni en los object streams)'
      : `sin /Root resoluble y ${roots.length} nodos /Pages raíz: ambiguo`,
  );
}
