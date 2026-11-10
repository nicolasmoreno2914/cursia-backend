/**
 * r107 B1 · Taller de cursos — lector SEGURO de un .mbz subido por el usuario (dato no confiable, diseño §7).
 *
 * Puro (sin Nest, sin base, sin red) y reutilizable por B2 (inventario) y B3 (diagnóstico):
 *  - abre ZIP (formato Moodle 2 de los builders de Cursia) o tar.gz (re-exportes de Moodle / cursos viejos) por sus
 *    BYTES MÁGICOS, nunca por la extensión;
 *  - trabaja SOLO en memoria: nunca escribe a disco (ni siquiera a un directorio temporal) ni ejecuta nada del paquete;
 *    los JS de un SCORM son bytes como cualquier otro;
 *  - límites anti zip-bomb ANTES de descomprimir: cantidad de entradas, total descomprimido declarado y razón de
 *    compresión por entrada; al descomprimir, el tope de salida es el tamaño declarado (una entrada que miente sobre su
 *    tamaño se corta y se rechaza), y el CRC se verifica cuando el runtime trae `zlib.crc32`;
 *  - rechaza el paquete ENTERO si alguna ruta es absoluta, tiene `..`, letra de unidad, caracteres de control, es un
 *    enlace (tar) o está repetida (dos entradas con el mismo nombre: lo que lee el Taller y lo que restaura Moodle
 *    podrían ser distintos).
 *
 * Errores: `MbzReaderError` con `code` estable y `message` en español para el usuario (ningún detalle interno).
 */
import * as zlib from 'zlib';
import { promisify } from 'util';

// Fix P2-4: inflado asíncrono (pool de libuv) — un moodle_backup.xml de 64 MB no bloquea el event loop de la API.
const inflateRawAsync = promisify(zlib.inflateRaw) as (buf: Buffer, opts: zlib.ZlibOptions) => Promise<Buffer>;

export type MbzContainer = 'zip' | 'tar.gz';

export interface MbzReaderLimits {
  /** Tamaño máximo del paquete comprimido (bytes). Diseño §11: 300 MB. */
  maxPackageBytes: number;
  /** Cantidad máxima de entradas (archivos + carpetas). */
  maxEntries: number;
  /** Total descomprimido máximo (suma de los tamaños de todas las entradas). */
  maxTotalUncompressedBytes: number;
  /** Razón máxima descomprimido / comprimido de UNA entrada grande (zip) o del flujo gzip (tar.gz). */
  maxCompressionRatio: number;
  /** La razón solo se exige a partir de este tamaño descomprimido (un XML chico puede comprimir mucho, legítimamente). */
  ratioMinBytes: number;
  /** Largo máximo de un nombre de entrada. */
  maxNameLength: number;
  /**
   * Fix P2-5: presupuesto ACUMULADO de bytes descomprimidos que se pueden leer de UN paquete abierto (todas las
   * llamadas a readEntry / readEntries / readText suman). Corta un inventario de B2/B3 que intentara materializar los
   * 2 GB declarados (p. ej. miles de entradas chicas que no llegan al umbral de la razón).
   */
  maxReadBytes: number;
}

/**
 * Valores medidos sobre el corpus de B0 (259 paquetes únicos): la entrada real con más compresión es un questions.xml
 * de ~0,4 MB a 19×; el sintético v3 llega a 408× en un blob de 2 MB (por eso la razón solo se exige desde 8 MB). Un
 * bloque de ceros comprime ~1000× con DEFLATE: cualquier entrada ≥ 8 MB por encima de 200× es una bomba, no un curso.
 */
export const MBZ_READER_LIMITS: Readonly<MbzReaderLimits> = Object.freeze({
  maxPackageBytes: 300 * 1024 * 1024,
  maxEntries: 20_000,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  ratioMinBytes: 8 * 1024 * 1024,
  maxNameLength: 1024,
  maxReadBytes: 1024 * 1024 * 1024,
});

export type MbzReaderErrorCode =
  | 'not_mbz'
  | 'package_too_large'
  | 'too_many_entries'
  | 'unsafe_path'
  | 'duplicate_entry'
  | 'zip_bomb'
  | 'unsupported_entry'
  | 'corrupt'
  | 'entry_not_found'
  | 'entry_too_large'
  | 'read_budget_exceeded';

export class MbzReaderError extends Error {
  constructor(readonly code: MbzReaderErrorCode, message: string, readonly entry?: string) {
    super(message);
    this.name = 'MbzReaderError';
  }
}

export interface MbzEntry {
  /** Nombre normalizado (sin `./` inicial; separador `/`). */
  name: string;
  /** Tamaño descomprimido declarado (bytes). */
  size: number;
  /** Tamaño comprimido (zip); en tar.gz, null (el flujo se comprime entero). */
  compressedSize: number | null;
}

export interface ReadEntryOptions {
  /** Tope propio de esta lectura (p. ej. 64 MB para un XML): más grande → `entry_too_large`, sin descomprimir. */
  maxBytes?: number;
}

export interface MbzPackage {
  container: MbzContainer;
  /** Archivos del paquete (sin carpetas), en el orden del contenedor. */
  entries: readonly MbzEntry[];
  /** Suma de los tamaños declarados de los archivos. */
  totalUncompressedBytes: number;
  has(name: string): boolean;
  entry(name: string): MbzEntry | null;
  /** Bytes de UNA entrada. Falla con `entry_not_found` si no existe. */
  readEntry(name: string, opts?: ReadEntryOptions): Promise<Buffer>;
  /** Varias entradas en UNA pasada (en tar.gz evita descomprimir el flujo una vez por entrada). Las que no existen no vienen. */
  readEntries(names: readonly string[], opts?: ReadEntryOptions): Promise<Map<string, Buffer>>;
  /** Texto UTF-8 de una entrada, o null si no existe. */
  readText(name: string, opts?: ReadEntryOptions): Promise<string | null>;
}

// ─── Contenedor por bytes mágicos ───────────────────────────────────────────

export function detectContainer(buf: Buffer): MbzContainer | null {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  // Local file header (PK\3\4) o un zip vacío (PK\5\6, solo el directorio central).
  if (buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06))) return 'zip';
  if (buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) return 'tar.gz';
  return null;
}

// ─── Nombres de entrada ─────────────────────────────────────────────────────

/**
 * Nombre normalizado o motivo de rechazo. Se acepta `./` al inicio (tar de Moodle) y `/` al final (carpeta); todo lo
 * demás que pueda salir del directorio de trabajo de quien lo extraiga se rechaza.
 */
export function normalizeEntryName(raw: string, maxLen = MBZ_READER_LIMITS.maxNameLength): { name: string; dir: boolean } | { problem: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { problem: 'nombre vacío' };
  if (raw.length > maxLen) return { problem: 'nombre demasiado largo' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { problem: 'caracteres de control en el nombre' };
  let s = raw.replace(/\\/g, '/');
  if (s.startsWith('/')) return { problem: 'ruta absoluta' };
  if (/^[A-Za-z]:/.test(s)) return { problem: 'ruta con letra de unidad' };
  while (s.startsWith('./')) s = s.slice(2);
  const dir = s.endsWith('/');
  if (dir) s = s.replace(/\/+$/, '');
  if (s === '' || s === '.') return { name: '', dir: true }; // la raíz misma («./» del tar)
  const segs = s.split('/');
  if (segs.some((x) => x === '..')) return { problem: 'ruta con «..»' };
  if (segs.some((x) => x === '' || x === '.')) return { problem: 'ruta con segmentos vacíos o «.»' };
  return { name: s, dir };
}

function unsafe(raw: string, problem: string): MbzReaderError {
  return new MbzReaderError('unsafe_path', `El paquete trae una ruta insegura (${problem}): ${JSON.stringify(String(raw).slice(0, 120))}. Por seguridad no se abre.`, String(raw).slice(0, 200));
}

const MB = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

function bombError(name: string, size: number, ratio: number): MbzReaderError {
  return new MbzReaderError('zip_bomb', `El paquete parece una «bomba» de compresión: ${JSON.stringify(name.slice(0, 120))} se expande ${Math.round(ratio)} veces (${MB(size)}). No se abre.`, name);
}

// ─── Límites comunes ────────────────────────────────────────────────────────

function resolveLimits(l?: Partial<MbzReaderLimits>): MbzReaderLimits {
  return { ...MBZ_READER_LIMITS, ...(l ?? {}) };
}

function entryTooLarge(name: string, size: number, max: number): MbzReaderError {
  return new MbzReaderError('entry_too_large', `La entrada ${JSON.stringify(name.slice(0, 120))} pesa ${MB(size)} (máximo para esta lectura: ${MB(max)}).`, name);
}

// ─── ZIP ────────────────────────────────────────────────────────────────────

interface ZipEntryInternal extends MbzEntry {
  method: number;
  crc32: number;
  localHeaderOffset: number;
  /** Rango de los datos comprimidos [dataStart, dataEnd) (fix P2-5: detección de entradas superpuestas). */
  dataStart: number;
  dataEnd: number;
  /** r107 B4: banderas, hora y fecha DOS del directorio central (el motor de parches las conserva al reescribir). */
  flags: number;
  modTime: number;
  modDate: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function corrupt(detail: string): MbzReaderError {
  return new MbzReaderError('corrupt', `El archivo está dañado o incompleto (${detail}); vuelve a descargarlo de Moodle o de Cursia y súbelo otra vez.`);
}

function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt('tamaño de 64 bits fuera de rango');
  return Number(v);
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function parseZip(buf: Buffer, limits: MbzReaderLimits): ZipEntryInternal[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw corrupt('no se encontró el directorio central del zip');
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const diskNo = buf.readUInt16LE(eocd + 4);
  if (diskNo !== 0 && diskNo !== 0xffff) throw new MbzReaderError('unsupported_entry', 'El paquete está partido en varios volúmenes; súbelo en un solo archivo.');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOCATOR) throw corrupt('zip64 sin localizador');
    const rec = u64(buf, loc + 8);
    if (rec + 56 > buf.length || buf.readUInt32LE(rec) !== SIG_EOCD64) throw corrupt('zip64 sin registro final');
    total = u64(buf, rec + 32);
    cdSize = u64(buf, rec + 40);
    cdOffset = u64(buf, rec + 48);
  }
  // Antes de recorrer nada: la cantidad declarada.
  if (total > limits.maxEntries) {
    throw new MbzReaderError('too_many_entries', `El paquete declara ${total} archivos (máximo ${limits.maxEntries}). No parece un curso de Cursia; no se abre.`);
  }
  if (cdOffset + cdSize > buf.length) throw corrupt('directorio central fuera del archivo');
  const out: ZipEntryInternal[] = [];
  const seen = new Set<string>();
  let totalUncompressed = 0;
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw corrupt(`entrada ${i + 1} del directorio central`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const modTime = buf.readUInt16LE(p + 12);
    const modDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > buf.length) throw corrupt(`entrada ${i + 1} cortada`);
    const raw = buf.subarray(p + 46, nameEnd).toString('utf8');
    // zip64: los campos en 0xFFFFFFFF vienen en el extra 0x0001, en este orden.
    if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let e = nameEnd;
      const eEnd = nameEnd + extraLen;
      let found = false;
      while (e + 4 <= eEnd) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(buf, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(buf, q); q += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(buf, q); q += 8; }
          found = true;
          break;
        }
        e += 4 + len;
      }
      if (!found) throw corrupt(`entrada zip64 sin datos extendidos (${raw.slice(0, 80)})`);
    }
    p = nameEnd + extraLen + commentLen;

    const n = normalizeEntryName(raw, limits.maxNameLength);
    if ('problem' in n) throw unsafe(raw, n.problem);
    if (n.dir) continue; // carpetas: validadas, no listadas
    if (flags & 0x1) throw new MbzReaderError('unsupported_entry', `El paquete trae archivos cifrados (${JSON.stringify(n.name.slice(0, 120))}); Moodle no los restaura. No se abre.`, n.name);
    if (method !== 0 && method !== 8) throw new MbzReaderError('unsupported_entry', `El paquete usa una compresión no soportada (método ${method}) en ${JSON.stringify(n.name.slice(0, 120))}.`, n.name);
    if (seen.has(n.name)) throw new MbzReaderError('duplicate_entry', `El paquete trae dos archivos con el mismo nombre (${JSON.stringify(n.name.slice(0, 120))}); no se sabe cuál restauraría Moodle. No se abre.`, n.name);
    seen.add(n.name);
    if (method === 0 && size !== compressedSize) throw corrupt(`entrada sin compresión con tamaños distintos (${n.name.slice(0, 80)})`);
    if (size >= limits.ratioMinBytes && size / Math.max(1, compressedSize) > limits.maxCompressionRatio) throw bombError(n.name, size, size / Math.max(1, compressedSize));
    totalUncompressed += size;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new MbzReaderError('zip_bomb', `El paquete se expande a más de ${MB(limits.maxTotalUncompressedBytes)} al descomprimirlo. No parece un curso; no se abre.`);
    }
    if (localHeaderOffset + 30 > buf.length) throw corrupt(`entrada fuera del archivo (${n.name.slice(0, 80)})`);
    if (buf.readUInt32LE(localHeaderOffset) !== SIG_LOCAL) throw corrupt(`cabecera local de ${n.name.slice(0, 80)}`);
    const dataStart = localHeaderOffset + 30 + buf.readUInt16LE(localHeaderOffset + 26) + buf.readUInt16LE(localHeaderOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) throw corrupt(`datos de ${n.name.slice(0, 80)} fuera de su lugar`);
    out.push({ name: n.name, size, compressedSize, method, crc32: crc, localHeaderOffset, dataStart, dataEnd, flags, modTime, modDate });
  }
  // Fix P2-5: dos entradas que comparten bytes comprimidos (bomba «superpuesta», Fifield 2019) → el paquete entero fuera.
  const byStart = [...out].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (let i = 1; i < byStart.length; i++) {
    if (byStart[i].localHeaderOffset < byStart[i - 1].dataEnd) {
      throw new MbzReaderError('zip_bomb', `El paquete trae archivos superpuestos (${JSON.stringify(byStart[i].name.slice(0, 80))} reutiliza los datos de otro): es una técnica de «bomba» de compresión. No se abre.`, byStart[i].name);
    }
  }
  return out;
}

async function readZipEntry(buf: Buffer, e: ZipEntryInternal): Promise<Buffer> {
  if (e.dataEnd > buf.length) throw corrupt(`datos de ${e.name.slice(0, 80)} fuera del archivo`);
  const data = buf.subarray(e.dataStart, e.dataEnd);
  let out: Buffer;
  if (e.method === 0) {
    out = Buffer.from(data);
  } else {
    if (e.size === 0) {
      out = Buffer.alloc(0);
    } else {
      try {
        // El tope de salida es el tamaño declarado: una entrada que se expande más de lo que dice se corta acá.
        out = await inflateRawAsync(data, { maxOutputLength: e.size });
      } catch (err) {
        const msg = err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}` : String(err);
        if (/maxOutputLength|ERR_BUFFER_TOO_LARGE|buffer|larger/i.test(msg)) throw bombError(e.name, e.size, e.size / Math.max(1, e.compressedSize));
        throw corrupt(`no se pudo descomprimir ${e.name.slice(0, 80)}`);
      }
    }
  }
  if (out.length !== e.size) throw corrupt(`${e.name.slice(0, 80)} no tiene el tamaño que declara`);
  const crc32 = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof crc32 === 'function' && (crc32(out) >>> 0) !== (e.crc32 >>> 0)) throw corrupt(`CRC de ${e.name.slice(0, 80)}`);
  return out;
}

// ─── TAR.GZ (en flujo: nunca se materializa el tar entero) ──────────────────

interface TarEntryInternal extends MbzEntry {
  /** Índice entre los archivos, en el orden del flujo. */
  index: number;
}

const TAR_BLOCK = 512;

function tarString(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

function tarNumber(b: Buffer, off: number, len: number): number {
  // base-256 (bit alto) para tamaños grandes; si no, octal ASCII.
  if (b[off] & 0x80) {
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i];
    return v;
  }
  const s = tarString(b, off, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw corrupt('cabecera tar con un número inválido');
  return parseInt(s, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp < 0) break;
    const len = parseInt(data.subarray(p, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || p + len > data.length) break;
    const rec = data.subarray(sp + 1, p + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

/** Visitante de un flujo tar: `onFile` decide si se guardan los bytes de cada archivo (`collect` los recibe); `done` corta. */
interface TarVisit {
  onFile(e: { name: string; size: number }): boolean;
  collect?(name: string, data: Buffer): void;
  done?(): boolean;
}

/**
 * Recorre el tar dentro del gzip en flujo, aplicando los límites mientras descomprime (antes de que la bomba crezca).
 * Los nombres se validan con las mismas reglas que el zip; enlaces y dispositivos se rechazan.
 */
async function walkTarGz(buf: Buffer, limits: MbzReaderLimits, visit: TarVisit): Promise<void> {
  const gunzip = zlib.createGunzip();
  let pending: Buffer = Buffer.alloc(0);
  let produced = 0;
  let stopped = false;
  let failure: Error | null = null;
  // Estado del parser.
  type State = { kind: 'header' } | { kind: 'data'; left: number; pad: number; keep: Buffer[] | null; meta: 'L' | 'x' | null; name: string; size: number };
  let st: State = { kind: 'header' };
  let longName: string | null = null;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let zeroBlocks = 0;
  let entries = 0;
  let total = 0;
  const seen = new Set<string>();

  const fail = (e: Error) => {
    if (!failure) failure = e;
    stopped = true;
  };

  const startEntry = (h: Buffer) => {
    entries++;
    if (entries > limits.maxEntries) throw new MbzReaderError('too_many_entries', `El paquete tiene más de ${limits.maxEntries} archivos. No parece un curso de Cursia; no se abre.`);
    const sum = tarNumber(h, 148, 8);
    let calc = 0;
    for (let i = 0; i < TAR_BLOCK; i++) calc += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== calc) throw corrupt('cabecera tar con suma de control inválida');
    const type = String.fromCharCode(h[156] || 0x30);
    let size = tarNumber(h, 124, 12);
    const magic = tarString(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? tarString(h, 345, 155) : '';
    let raw = (prefix ? prefix + '/' : '') + tarString(h, 0, 100);
    if (type === 'L' || type === 'x' || type === 'g') {
      if (size > 1024 * 1024) throw corrupt('metadatos tar demasiado grandes');
      return { left: size, meta: (type === 'g' ? null : type) as 'L' | 'x' | null, name: '', size, keep: type === 'g' ? null : [] };
    }
    if (longName !== null) { raw = longName; longName = null; }
    if (paxPath !== null) { raw = paxPath; paxPath = null; }
    if (paxSize !== null) { size = paxSize; paxSize = null; }
    if (type === '1' || type === '2') throw unsafe(raw, 'enlace dentro del paquete');
    if (type !== '0' && type !== '\0' && type !== '5' && type !== '7') {
      throw new MbzReaderError('unsupported_entry', `El paquete trae una entrada tar de tipo no soportado (${JSON.stringify(type)}): ${JSON.stringify(raw.slice(0, 120))}.`, raw);
    }
    const n = normalizeEntryName(raw, limits.maxNameLength);
    if ('problem' in n) throw unsafe(raw, n.problem);
    if (type === '5' || n.dir) return { left: size, meta: null, name: '', size, keep: null };
    if (seen.has(n.name)) throw new MbzReaderError('duplicate_entry', `El paquete trae dos archivos con el mismo nombre (${JSON.stringify(n.name.slice(0, 120))}); no se sabe cuál restauraría Moodle. No se abre.`, n.name);
    seen.add(n.name);
    total += size;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new MbzReaderError('zip_bomb', `El paquete se expande a más de ${MB(limits.maxTotalUncompressedBytes)} al descomprimirlo. No parece un curso; no se abre.`);
    }
    const want = visit.onFile({ name: n.name, size });
    return { left: size, meta: null, name: n.name, size, keep: want ? ([] as Buffer[]) : null };
  };

  const consume = () => {
    while (!stopped) {
      if (st.kind === 'header') {
        if (pending.length < TAR_BLOCK) return;
        const h = pending.subarray(0, TAR_BLOCK);
        pending = pending.subarray(TAR_BLOCK);
        if (h.every((x) => x === 0)) {
          zeroBlocks++;
          if (zeroBlocks >= 2) { stopped = true; return; }
          continue;
        }
        zeroBlocks = 0;
        const e = startEntry(Buffer.from(h));
        const pad = (TAR_BLOCK - (e.left % TAR_BLOCK)) % TAR_BLOCK;
        st = { kind: 'data', left: e.left, pad, keep: e.keep, meta: e.meta, name: e.name, size: e.size };
        if (e.left === 0) finishEntry();
        continue;
      }
      // data
      if (st.left > 0) {
        if (pending.length === 0) return;
        const take = Math.min(st.left, pending.length);
        if (st.keep) st.keep.push(Buffer.from(pending.subarray(0, take)));
        pending = pending.subarray(take);
        st.left -= take;
        if (st.left > 0) return;
      }
      if (st.pad > 0) {
        if (pending.length < st.pad) return;
        pending = pending.subarray(st.pad);
        st.pad = 0;
      }
      finishEntry();
    }
  };

  const finishEntry = () => {
    if (st.kind !== 'data') return;
    const s = st;
    st = { kind: 'header' };
    if (s.meta === 'L' && s.keep) longName = tarString(Buffer.concat(s.keep), 0, s.size);
    else if (s.meta === 'x' && s.keep) {
      const pax = parsePax(Buffer.concat(s.keep));
      if (pax.path !== undefined) paxPath = pax.path;
      if (pax.size !== undefined) {
        const v = Number(pax.size);
        if (!Number.isSafeInteger(v) || v < 0) throw corrupt('tamaño pax inválido');
        paxSize = v;
      }
    } else if (s.keep && s.name && visit.collect) {
      visit.collect(s.name, Buffer.concat(s.keep));
    }
    if (visit.done && visit.done()) stopped = true;
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    gunzip.on('data', (chunk: Buffer) => {
      if (stopped) return;
      produced += chunk.length;
      if (produced > limits.maxTotalUncompressedBytes + 10 * 1024 * 1024) {
        fail(new MbzReaderError('zip_bomb', `El paquete se expande a más de ${MB(limits.maxTotalUncompressedBytes)} al descomprimirlo. No parece un curso; no se abre.`));
      } else if (produced >= limits.ratioMinBytes && produced / Math.max(1, buf.length) > limits.maxCompressionRatio) {
        fail(bombError('(flujo tar.gz)', produced, produced / Math.max(1, buf.length)));
      } else {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        try { consume(); } catch (err) { fail(err as Error); }
      }
      if (stopped) { gunzip.removeAllListeners('data'); gunzip.destroy(); finish(); }
    });
    gunzip.on('error', (err) => {
      if (!stopped) fail(err instanceof MbzReaderError ? err : corrupt('el gzip no se pudo descomprimir'));
      finish();
    });
    gunzip.on('end', () => {
      if (!stopped && !failure) {
        try { consume(); } catch (err) { fail(err as Error); }
        if (!stopped && !failure && (st.kind === 'data' || pending.length > 0)) fail(corrupt('el tar termina a mitad de una entrada'));
      }
      finish();
    });
    gunzip.on('close', finish);
    gunzip.end(buf);
  });
  if (failure) throw failure;
}

async function indexTarGz(buf: Buffer, limits: MbzReaderLimits): Promise<TarEntryInternal[]> {
  const out: TarEntryInternal[] = [];
  await walkTarGz(buf, limits, {
    onFile(e) {
      out.push({ name: e.name, size: e.size, compressedSize: null, index: out.length });
      return false;
    },
  });
  return out;
}

async function collectTarGz(buf: Buffer, limits: MbzReaderLimits, names: Set<string>): Promise<Map<string, Buffer>> {
  const got = new Map<string, Buffer>();
  const v: TarVisit = {
    onFile: (e) => names.has(e.name),
    collect: (n, d) => { got.set(n, d); },
    done: () => got.size >= names.size,
  };
  await walkTarGz(buf, limits, v);
  return got;
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Abre un .mbz (zip o tar.gz) en memoria con los límites del Taller. Todo rechazo es un `MbzReaderError` con un motivo
 * claro; nada se escribe a disco.
 */
export async function openMbz(buf: Buffer, limitsIn?: Partial<MbzReaderLimits>): Promise<MbzPackage> {
  return asReaderError(() => openMbzInner(buf, limitsIn));
}

/**
 * Fix P2-3: toda falla que NO sea un `MbzReaderError` mientras se interpreta el paquete (un `RangeError` de
 * `readUInt*` en un extra / pax construido al borde del buffer, un error de zlib…) es ENTRADA MALFORMADA: se convierte en
 * `corrupt` (no reintentable, motivo claro), nunca en un fallo genérico que se reintentaría descargando otra vez.
 */
export async function asReaderError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MbzReaderError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    const what = err instanceof RangeError || /^ERR_(OUT_OF_RANGE|BUFFER_OUT_OF_BOUNDS|INVALID_ARG)/.test(String(code ?? ''))
      ? 'estructura interna inconsistente'
      : /^Z_|zlib|incorrect header|invalid (block|distance|stored)/i.test(`${code ?? ''} ${err instanceof Error ? err.message : ''}`)
        ? 'datos comprimidos inválidos'
        : 'formato no reconocido';
    throw corrupt(what);
  }
}

async function openMbzInner(buf: Buffer, limitsIn?: Partial<MbzReaderLimits>): Promise<MbzPackage> {
  const limits = resolveLimits(limitsIn);
  // Fix P2-5: presupuesto acumulado de lectura de ESTE paquete abierto.
  let readSoFar = 0;
  const charge = (name: string, size: number) => {
    if (readSoFar + size > limits.maxReadBytes) {
      throw new MbzReaderError('read_budget_exceeded', `Leer ${JSON.stringify(name.slice(0, 120))} superaría los ${MB(limits.maxReadBytes)} que se pueden descomprimir de un paquete. No se continúa.`, name);
    }
    readSoFar += size;
  };
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new MbzReaderError('not_mbz', 'El archivo está vacío.');
  if (buf.length > limits.maxPackageBytes) {
    throw new MbzReaderError('package_too_large', `El archivo pesa ${MB(buf.length)}; el máximo es ${MB(limits.maxPackageBytes)}.`);
  }
  const container = detectContainer(buf);
  if (!container) throw new MbzReaderError('not_mbz', 'El archivo no es un .mbz de Moodle (no es un zip ni un tar.gz). Descárgalo de nuevo desde Cursia o Moodle.');

  if (container === 'zip') {
    const list = parseZip(buf, limits);
    const byName = new Map(list.map((e) => [e.name, e]));
    const pub: MbzEntry[] = list.map((e) => ({ name: e.name, size: e.size, compressedSize: e.compressedSize }));
    const totalUncompressedBytes = list.reduce((s, e) => s + e.size, 0);
    const read = (name: string, opts?: ReadEntryOptions): Promise<Buffer> => asReaderError(async () => {
      const e = byName.get(name);
      if (!e) throw new MbzReaderError('entry_not_found', `El paquete no tiene ${JSON.stringify(name.slice(0, 120))}.`, name);
      if (opts?.maxBytes !== undefined && e.size > opts.maxBytes) throw entryTooLarge(name, e.size, opts.maxBytes);
      charge(name, e.size);
      return readZipEntry(buf, e);
    });
    return {
      container,
      entries: pub,
      totalUncompressedBytes,
      has: (n) => byName.has(n),
      entry: (n) => {
        const e = byName.get(n);
        return e ? { name: e.name, size: e.size, compressedSize: e.compressedSize } : null;
      },
      readEntry: (n, o) => read(n, o),
      readEntries: async (names, o) => {
        const m = new Map<string, Buffer>();
        for (const n of names) if (byName.has(n)) m.set(n, await read(n, o));
        return m;
      },
      readText: async (n, o) => (byName.has(n) ? (await read(n, o)).toString('utf8') : null),
    };
  }

  const list = await indexTarGz(buf, limits);
  const byName = new Map(list.map((e) => [e.name, e]));
  const pub: MbzEntry[] = list.map((e) => ({ name: e.name, size: e.size, compressedSize: null }));
  const totalUncompressedBytes = list.reduce((s, e) => s + e.size, 0);
  const readMany = async (names: readonly string[], opts?: ReadEntryOptions): Promise<Map<string, Buffer>> => {
    const want = new Set<string>();
    for (const n of names) {
      const e = byName.get(n);
      if (!e) continue;
      if (opts?.maxBytes !== undefined && e.size > opts.maxBytes) throw entryTooLarge(n, e.size, opts.maxBytes);
      if (!want.has(n)) { charge(n, e.size); want.add(n); }
    }
    if (!want.size) return new Map();
    return asReaderError(() => collectTarGz(buf, limits, want));
  };
  return {
    container,
    entries: pub,
    totalUncompressedBytes,
    has: (n) => byName.has(n),
    entry: (n) => {
      const e = byName.get(n);
      return e ? { name: e.name, size: e.size, compressedSize: null } : null;
    },
    readEntry: async (n, o) => {
      if (!byName.has(n)) throw new MbzReaderError('entry_not_found', `El paquete no tiene ${JSON.stringify(n.slice(0, 120))}.`, n);
      const got = await readMany([n], o);
      const b = got.get(n);
      if (!b) throw corrupt(`no se pudo leer ${n.slice(0, 80)}`);
      return b;
    },
    readEntries: readMany,
    readText: async (n, o) => {
      if (!byName.has(n)) return null;
      const got = await readMany([n], o);
      const b = got.get(n);
      return b ? b.toString('utf8') : null;
    },
  };
}

/**
 * r107 B4 · motor de parches: entradas de un ZIP con la ubicación de sus datos COMPRIMIDOS (para copiarlos tal cual al
 * reescribir el paquete: una entrada que el motor no toca conserva sus bytes comprimidos). Mismas validaciones que
 * `openMbz` (nombres, bombas, superposición); el orden es el del directorio central.
 */
export interface ZipRawEntry {
  name: string;
  method: number;
  crc32: number;
  size: number;
  compressedSize: number;
  dataStart: number;
  dataEnd: number;
  flags: number;
  modTime: number;
  modDate: number;
}
export function zipRawEntries(buf: Buffer, limitsIn?: Partial<MbzReaderLimits>): ZipRawEntry[] {
  return parseZip(buf, resolveLimits(limitsIn)).map((e) => ({
    name: e.name, method: e.method, crc32: e.crc32, size: e.size, compressedSize: e.compressedSize as number,
    dataStart: e.dataStart, dataEnd: e.dataEnd, flags: e.flags, modTime: e.modTime, modDate: e.modDate,
  }));
}

export function isMbzReaderError(e: unknown): e is MbzReaderError {
  return e instanceof MbzReaderError;
}
