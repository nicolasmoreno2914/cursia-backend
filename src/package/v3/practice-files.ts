// T5 (r57) — archivos de trabajo (recursos de práctica) del paquete v3.
//
//  - Subidos por el usuario (artifact `practice_file`): el worker los descarga y el builder verifica tamaño, sha256 (el
//    del perfil = el de los bytes), extensión permitida y firma del formato (PDF, OOXML/ODF = zip, imagen, texto).
//  - Generados de una tabla del perfil (CSV / XLSX): determinísticos (mismos datos → mismos bytes), sin dependencias
//    nuevas (XLSX = SpreadsheetML mínimo en un zip con jszip y fecha fija).
// Falla fuerte ante un archivo que no cumple (nunca se empaqueta un archivo distinto del declarado).
import * as JSZip from 'jszip';
import { createHash } from 'crypto';
import {
  PRACTICE_FILE_MIMETYPES,
  PRACTICE_RESOURCE_LIMITS,
  PracticeResourceSpec,
  PracticeTableCell,
  ResolvedPracticeResource,
  extensionOf,
} from '../../modules/course-profiles/application-delivery';

export const PRACTICE_FILE_ZIP_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

export class PracticeFileInvalidError extends Error {
  constructor(readonly resourceId: string, readonly code: string, detail: string) {
    super(`PRACTICE_FILE_INVALID: ${resourceId} [${code}] ${detail}`);
    this.name = 'PracticeFileInvalidError';
  }
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** CSV (RFC 4180, separador coma, CRLF, BOM UTF-8 para que Excel lea los acentos). */
export function tableToCsv(columns: readonly string[], rows: ReadonlyArray<ReadonlyArray<PracticeTableCell>>): Buffer {
  const cell = (v: PracticeTableCell): string => {
    if (v === null || v === undefined) return '';
    const t = typeof v === 'number' ? String(v) : v;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

const xesc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** XLSX mínimo válido (una hoja «Datos», encabezado en negrita, textos inline): Excel, LibreOffice y Moodle lo abren. */
export async function tableToXlsx(columns: readonly string[], rows: ReadonlyArray<ReadonlyArray<PracticeTableCell>>): Promise<Buffer> {
  const cellXml = (v: PracticeTableCell, ref: string, header: boolean): string => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
  };
  const all: ReadonlyArray<ReadonlyArray<PracticeTableCell>> = [columns, ...rows];
  const sheetRows = all
    .map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cellXml(v, `${colName(j)}${i + 1}`, i === 0)).join('')}</row>`)
    .join('');
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Datos" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  const z = new JSZip();
  for (const [n, d] of files) z.file(n, d, { date: PRACTICE_FILE_ZIP_DATE, createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

/** Firma del formato por extensión (lo mínimo para no publicar un archivo que no es lo que dice ser). */
export async function sniffMatchesExtension(ext: string, b: Buffer): Promise<boolean> {
  const starts = (sig: number[]) => sig.every((x, i) => b[i] === x);
  const isZip = starts([0x50, 0x4b, 0x03, 0x04]);
  switch (ext) {
    case '.pdf':
      return b.subarray(0, 5).toString('latin1') === '%PDF-';
    case '.png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case '.jpg':
      return starts([0xff, 0xd8, 0xff]);
    case '.zip':
      return isZip || starts([0x50, 0x4b, 0x05, 0x06]);
    case '.docx':
    case '.xlsx':
    case '.pptx':
    case '.odt':
    case '.ods':
    case '.odp': {
      if (!isZip) return false;
      try {
        const z = await JSZip.loadAsync(b);
        if (ext.startsWith('.od')) return !!z.file('mimetype');
        const main = ext === '.docx' ? 'word/document.xml' : ext === '.xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
        return !!z.file('[Content_Types].xml') && !!z.file(main);
      } catch {
        return false;
      }
    }
    case '.csv':
    case '.txt': {
      // Texto UTF-8 sin bytes de control (salvo tab/CR/LF).
      const t = b.toString('utf8');
      return !t.includes('�') && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t);
    }
    default:
      return false;
  }
}

export interface PracticeFilesResult {
  resolved: ResolvedPracticeResource[];
  /** resourceId → bytes del archivo a publicar. */
  bytes: Map<string, Buffer>;
  warnings: string[];
}

/**
 * Resuelve los archivos de trabajo del perfil contra los capítulos del curso. Un recurso de un capítulo que ya no está
 * en el curso se omite CON aviso (`practice_resource_orphan:<id>`); uno «de la Actividad de Aplicación» en un capítulo
 * sin AA pasa a material del capítulo CON aviso (`practice_resource_no_application:<id>`). Archivo faltante, distinto
 * (sha256/tamaño), de un tipo no permitido o que no es lo que dice su extensión → falla fuerte.
 */
export async function resolvePracticeFiles(
  specs: readonly PracticeResourceSpec[] | undefined | null,
  chapters: ReadonlyArray<{ chapterId: string; hasApplication: boolean }>,
  uploads: ReadonlyMap<string, Buffer> | undefined | null,
): Promise<PracticeFilesResult> {
  const resolved: ResolvedPracticeResource[] = [];
  const bytes = new Map<string, Buffer>();
  const warnings: string[] = [];
  const byChapter = new Map(chapters.map((c) => [c.chapterId, c]));
  let total = 0;
  for (const r of specs ?? []) {
    const ch = byChapter.get(r.chapterId);
    if (!ch) {
      warnings.push(`practice_resource_orphan:${r.id}`);
      continue;
    }
    let relation = r.relation;
    if (relation === 'application' && !ch.hasApplication) {
      warnings.push(`practice_resource_no_application:${r.id}`);
      relation = 'chapter';
    }
    const ext = extensionOf(r.source.filename);
    const mimetype = PRACTICE_FILE_MIMETYPES[ext];
    if (!mimetype) throw new PracticeFileInvalidError(r.id, 'FILE_TYPE_NOT_ALLOWED', `extensión ${ext || '(ninguna)'}`);
    let buf: Buffer;
    let origin: ResolvedPracticeResource['origin'];
    if (r.source.kind === 'artifact') {
      const up = uploads?.get(r.id);
      if (!up) throw new PracticeFileInvalidError(r.id, 'FILE_MISSING', `no llegó el archivo del artifact ${r.source.artifactId}`);
      if (up.length !== r.source.bytes) throw new PracticeFileInvalidError(r.id, 'FILE_SIZE_MISMATCH', `${up.length} bytes ≠ ${r.source.bytes} declarados`);
      if (sha256(up) !== r.source.sha256) throw new PracticeFileInvalidError(r.id, 'FILE_SHA256_MISMATCH', 'el archivo no es el que se adjuntó (sha256 distinto)');
      if (r.source.mimetype !== mimetype) throw new PracticeFileInvalidError(r.id, 'MIMETYPE_MISMATCH', `${r.source.mimetype} ≠ ${mimetype}`);
      buf = up;
      origin = 'upload';
    } else {
      if (`.${r.source.format}` !== ext) throw new PracticeFileInvalidError(r.id, 'FILE_EXTENSION_MISMATCH', `${r.source.filename} no es .${r.source.format}`);
      buf = r.source.format === 'csv' ? tableToCsv(r.source.columns, r.source.rows) : await tableToXlsx(r.source.columns, r.source.rows);
      origin = r.source.format;
    }
    if (buf.length < 1 || buf.length > PRACTICE_RESOURCE_LIMITS.fileBytesMax) throw new PracticeFileInvalidError(r.id, 'FILE_TOO_LARGE', `${buf.length} bytes (máx. ${PRACTICE_RESOURCE_LIMITS.fileBytesMax})`);
    if (!(await sniffMatchesExtension(ext, buf))) throw new PracticeFileInvalidError(r.id, 'FILE_CONTENT_MISMATCH', `el contenido no es un ${ext} válido`);
    total += buf.length;
    bytes.set(r.id, buf);
    resolved.push({ id: r.id, chapterId: r.chapterId, title: r.title, instructions: r.instructions, relation, filename: r.source.filename, mimetype, bytes: buf.length, sha256: sha256(buf), origin });
  }
  if (total > PRACTICE_RESOURCE_LIMITS.courseBytesMax) throw new PracticeFileInvalidError('*', 'RESOURCES_TOO_LARGE', `${total} bytes (máx. ${PRACTICE_RESOURCE_LIMITS.courseBytesMax})`);
  return { resolved, bytes, warnings };
}
