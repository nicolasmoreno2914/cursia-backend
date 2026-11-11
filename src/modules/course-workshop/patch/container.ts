/**
 * r107 B4 · motor de parches — ESTADO del paquete mientras se aplica un plan y su escritura final.
 *
 * El original nunca se toca: `PatchState` es una capa encima (entradas modificadas / agregadas / quitadas) que además se
 * presenta como un `MbzPackage` para que el inventario de B2 se rearme sobre el estado actual entre operaciones.
 *
 * Escritura:
 *   - ZIP → ZIP: las entradas NO tocadas copian sus bytes COMPRIMIDOS tal cual (mismo método, CRC y tamaños; solo se
 *     reescriben las cabeceras, sin descriptor de datos); las tocadas se comprimen con DEFLATE. Orden: el del original,
 *     las nuevas al final. Hora DOS: la de la entrada original; las nuevas, la de `moodle_backup.xml` (determinista).
 *   - TAR.GZ → TAR.GZ: ustar + PAX `path` para nombres largos; el contenido de cada entrada no tocada es el mismo
 *     (el flujo se recomprime entero: gzip no permite copiar tramos).
 */
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { MbzEntry, MbzPackage, ReadEntryOptions, ZipRawEntry, zipRawEntries } from '../mbz-reader';

const crc32 = (zlib as unknown as { crc32: (b: Buffer) => number }).crc32;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32Of(b: Buffer): number {
  if (typeof crc32 === 'function') return crc32(b) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const sha1Of = (b: Buffer | string): string => createHash('sha1').update(b).digest('hex');

export class PatchState {
  private readonly order: string[];
  private readonly changed = new Map<string, Buffer>();
  private readonly removed = new Set<string>();
  private readonly added: string[] = [];
  private readonly cache = new Map<string, Buffer>();

  private constructor(readonly original: MbzPackage, readonly originalBytes: Buffer) {
    this.order = original.entries.map((e) => e.name);
  }

  /** En tar.gz cada lectura recorre el flujo entero: se cargan todas las entradas UNA vez. */
  static async create(original: MbzPackage, originalBytes: Buffer): Promise<PatchState> {
    const s = new PatchState(original, originalBytes);
    if (original.container === 'tar.gz') {
      const all = await original.readEntries(s.order);
      for (const [k, v] of all) s.cache.set(k, v);
    }
    return s;
  }

  get container(): 'zip' | 'tar.gz' { return this.original.container; }

  /** Estado nuevo sobre el MISMO original y su caché de lecturas (pruebas en seco: cada una con su capa propia). */
  fork(): PatchState {
    const s = new PatchState(this.original, this.originalBytes);
    for (const [k, v] of this.cache) s.cache.set(k, v);
    return s;
  }

  has(name: string): boolean {
    if (this.removed.has(name)) return false;
    return this.changed.has(name) || this.original.has(name);
  }

  names(): string[] {
    return [...this.order.filter((n) => !this.removed.has(n)), ...this.added.filter((n) => !this.removed.has(n))];
  }

  async read(name: string): Promise<Buffer> {
    if (this.removed.has(name)) throw new Error(`entrada quitada: ${name}`);
    const c = this.changed.get(name);
    if (c) return c;
    const k = this.cache.get(name);
    if (k) return k;
    const b = await this.original.readEntry(name);
    this.cache.set(name, b);
    return b;
  }

  async readText(name: string): Promise<string> {
    return (await this.read(name)).toString('utf8');
  }

  write(name: string, data: Buffer | string): void {
    const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (this.removed.has(name)) this.removed.delete(name);
    if (!this.original.has(name) && !this.added.includes(name)) this.added.push(name);
    this.changed.set(name, b);
  }

  remove(name: string): void {
    if (!this.has(name)) return;
    this.changed.delete(name);
    this.removed.add(name);
  }

  /** Entradas cuyo contenido difiere del original (modificadas), agregadas y quitadas. */
  async touched(): Promise<{ modified: string[]; added: string[]; removed: string[] }> {
    const modified: string[] = [];
    for (const [n, b] of this.changed) {
      if (!this.original.has(n)) continue;
      const o = this.cache.get(n) ?? await this.original.readEntry(n);
      if (!o.equals(b)) modified.push(n);
    }
    return {
      modified: modified.sort(),
      added: this.added.filter((n) => !this.removed.has(n)).sort(),
      removed: [...this.removed].filter((n) => this.original.has(n)).sort(),
    };
  }

  /** Vista `MbzPackage` del estado actual (para el inventario de B2). */
  asPackage(): MbzPackage {
    const entries: MbzEntry[] = this.names().map((n) => ({ name: n, size: this.changed.get(n)?.length ?? this.original.entry(n)?.size ?? 0, compressedSize: null }));
    const byName = new Map(entries.map((e) => [e.name, e]));
    const readMany = async (names: readonly string[], opts?: ReadEntryOptions): Promise<Map<string, Buffer>> => {
      const m = new Map<string, Buffer>();
      for (const n of names) {
        const e = byName.get(n);
        if (!e) continue;
        if (opts?.maxBytes !== undefined && e.size > opts.maxBytes) throw new Error(`entrada demasiado grande: ${n}`);
        m.set(n, await this.read(n));
      }
      return m;
    };
    return {
      container: this.container,
      entries,
      totalUncompressedBytes: entries.reduce((s, e) => s + e.size, 0),
      readBudgetBytes: this.original.readBudgetBytes,
      has: (n) => byName.has(n),
      entry: (n) => byName.get(n) ?? null,
      readEntry: async (n) => { if (!byName.has(n)) throw new Error(`El paquete no tiene ${n}`); return this.read(n); },
      readEntries: readMany,
      readText: async (n) => (byName.has(n) ? (await this.read(n)).toString('utf8') : null),
    };
  }

  /** Escribe el paquete nuevo en el MISMO contenedor. `preserved` = entradas copiadas con sus bytes comprimidos. */
  async serialize(): Promise<{ bytes: Buffer; preserved: number }> {
    return this.container === 'zip' ? this.serializeZip() : { bytes: await this.serializeTarGz(), preserved: 0 };
  }

  private async serializeZip(): Promise<{ bytes: Buffer; preserved: number }> {
    const raw = new Map<string, ZipRawEntry>(zipRawEntries(this.originalBytes).map((e) => [e.name, e]));
    const ref = raw.get('moodle_backup.xml');
    const newTime = ref ? ref.modTime : 0;
    const newDate = ref ? ref.modDate : 0x5c21; // 2026-01-01
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    let preserved = 0;
    for (const name of this.names()) {
      const nameBuf = Buffer.from(name, 'utf8');
      const utf8Flag = /[^\x20-\x7e]/.test(name) ? 0x0800 : 0;
      const r = raw.get(name);
      let method: number; let crc: number; let csize: number; let usize: number; let data: Buffer; let time: number; let date: number; let flags: number;
      const ch = this.changed.get(name);
      if (!ch && r) {
        method = r.method; crc = r.crc32 >>> 0; csize = r.compressedSize; usize = r.size;
        data = this.originalBytes.subarray(r.dataStart, r.dataEnd);
        time = r.modTime; date = r.modDate; flags = (r.flags & 0x0806) | utf8Flag;
        preserved++;
      } else {
        const content = ch ?? await this.read(name);
        const deflated = zlib.deflateRawSync(content, { level: 6 });
        const stored = deflated.length >= content.length;
        method = stored ? 0 : 8; data = stored ? content : deflated;
        crc = crc32Of(content); csize = data.length; usize = content.length;
        time = r ? r.modTime : newTime; date = r ? r.modDate : newDate; flags = utf8Flag;
      }
      if (csize > 0xfffffffe || usize > 0xfffffffe || offset > 0xfffffffe) throw new Error('el paquete supera 4 GB (zip64 no soportado por el motor de parches)');
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18);
      lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8);
      cd.writeUInt16LE(method, 10); cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(csize, 20); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(offset, 42);
      parts.push(lh, nameBuf, data);
      central.push(cd, nameBuf);
      offset += 30 + nameBuf.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const count = this.names().length;
    if (count > 0xffff) throw new Error('demasiadas entradas para un zip sin zip64');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return { bytes: Buffer.concat([...parts, cdBuf, eocd]), preserved };
  }

  /** Carpetas implícitas de una lista de archivos, cada una antes de su primer archivo (como lista `tgz_packer`). */
  private static tarItems(files: string[]): Array<{ path: string; dir: boolean }> {
    const items: Array<{ path: string; dir: boolean }> = [];
    const seenDir = new Set<string>();
    for (const n of files) {
      const parts = n.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = `${parts.slice(0, i).join('/')}/`;
        if (!seenDir.has(d)) { seenDir.add(d); items.push({ path: d, dir: true }); }
      }
      items.push({ path: n, dir: false });
    }
    return items;
  }

  /**
   * Antes de escribir (lo llama el motor, así el cambio entra al informe): en un tar.gz que traía `.ARCHIVE_INDEX` se
   * regenera con el formato de `tgz_packer` para el conjunto de entradas FINAL. Devuelve true si cambió.
   */
  async finalize(): Promise<boolean> {
    const INDEX = '.ARCHIVE_INDEX';
    if (this.container !== 'tar.gz' || !this.has(INDEX)) return false;
    const items = PatchState.tarItems(this.names().filter((n) => n !== INDEX));
    let list = `Moodle archive file index. Count: ${items.length}\n`;
    for (const it of items) list += `${it.path}\t${it.dir ? 'd' : 'f'}\t${it.dir ? 0 : (await this.read(it.path)).length}\t?\n`;
    const lb = Buffer.from(list, 'utf8');
    if ((await this.read(INDEX)).equals(lb)) return false;
    this.write(INDEX, lb);
    return true;
  }

  /**
   * Fix round 1 (P2-1): tar igual al de Moodle (`tgz_packer`): `.ARCHIVE_INDEX` PRIMERO y REGENERADO (si el original lo
   * traía) con la cuenta y una línea por carpeta y archivo (el extractor lo usa como lista y para el progreso: uno viejo
   * da archivos fantasma o un progreso que se pasa del máximo), carpetas como entradas `5`, nombres largos partidos en
   * `prefix` (≤ 155) + `name` (≤ 100) por una barra — nunca PAX, que el extractor de Moodle no entiende; si un nombre
   * no entra, la escritura falla.
   */
  private async serializeTarGz(): Promise<Buffer> {
    const DEFAULT_TIMESTAMP = 1356998400; // tgz_packer::DEFAULT_TIMESTAMP
    const INDEX = '.ARCHIVE_INDEX';
    const split = (path: string): { name: string; prefix: string } => {
      let name = path;
      let prefix = '';
      while (Buffer.byteLength(name, 'utf8') > 100) {
        const slash = name.indexOf('/');
        if (slash < 0) throw new Error(`nombre demasiado largo para tar: ${path.slice(0, 120)}`);
        prefix = prefix ? `${prefix}/${name.slice(0, slash)}` : name.slice(0, slash);
        name = name.slice(slash + 1);
        if (Buffer.byteLength(prefix, 'utf8') > 155) throw new Error(`ruta demasiado larga para tar: ${path.slice(0, 120)}`);
      }
      return { name, prefix };
    };
    const header = (path: string, size: number, dir: boolean): Buffer => {
      const { name, prefix } = split(path);
      const h = Buffer.alloc(512);
      h.write(name, 0, 100, 'utf8');
      h.write(dir ? '0000755\0' : '0000644\0', 100, 'ascii'); h.write('0000000\0', 108, 'ascii'); h.write('0000000\0', 116, 'ascii');
      if (size.toString(8).length > 11) throw new Error(`archivo demasiado grande para tar: ${path}`);
      h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
      h.write(DEFAULT_TIMESTAMP.toString(8).padStart(11, '0') + '\0', 136, 'ascii');
      h.write('        ', 148, 'ascii');
      h.write(dir ? '5' : '0', 156, 'ascii');
      h.write('ustar\0' + '00', 257, 'ascii');
      h.write(prefix, 345, 155, 'utf8');
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += h[i];
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
      return h;
    };
    const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
    const files = this.names().filter((n) => n !== INDEX);
    const items = PatchState.tarItems(files);
    for (const it of items) split(it.path); // falla ANTES de escribir nada si algún nombre no entra
    const blocks: Buffer[] = [];
    if (this.has(INDEX)) {
      const lb = await this.read(INDEX);
      blocks.push(header(INDEX, lb.length, false), lb, pad(lb.length));
    }
    for (const it of items) {
      if (it.dir) { blocks.push(header(it.path, 0, true)); continue; }
      const data = await this.read(it.path);
      blocks.push(header(it.path, data.length, false), data, pad(data.length));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks), { level: 6 });
  }
}
