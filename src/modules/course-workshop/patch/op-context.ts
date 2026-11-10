/**
 * r107 B4 · motor de parches — contexto de UNA operación: el estado del paquete y el inventario rearmado sobre él (B2,
 * con HTML), el contexto de tokens y el asignador de ids. Lo arma el motor antes de cada operación.
 */
import { RawCourse, TokenContext, WorkshopCourse, WorkshopFile } from '../course-model';
import { WorkshopFamily } from '../identify';
import { PatchState, sha1Of } from './container';
import { IdAllocator } from './ids';
import { FileChange, OperationReport, PatchError } from './types';

export interface OpContext {
  state: PatchState;
  inv: WorkshopCourse;
  raw: RawCourse;
  tokenCtx: TokenContext;
  family: WorkshopFamily;
  ids: () => Promise<IdAllocator>;
  report: OperationReport;
}

export const blobPath = (h: string): string => `files/${h.slice(0, 2)}/${h}`;

/** Todos los <file> de files.xml (con contexto) del estado actual. */
export function allFiles(ctx: OpContext): Array<{ contextId: number | null; file: WorkshopFile }> {
  return ctx.raw.allFiles;
}

/**
 * Reemplaza el contenido de un blob: blob nuevo con su sha1, TODAS las entradas de files.xml que usaban el viejo pasan
 * al nuevo (hash + tamaño + mimetype si cambia), y el viejo se quita si nadie más lo usa. Edita files.xml por posición.
 */
export async function replaceBlob(ctx: OpContext, oldHash: string, data: Buffer, mimetype?: string | null): Promise<string> {
  const nh = sha1Of(data);
  const r = ctx.report;
  if (nh === oldHash) return nh;
  const nEntry = blobPath(nh);
  if (!ctx.state.has(nEntry)) { ctx.state.write(nEntry, data); r.entriesAdded.push(nEntry); }
  let xml = await ctx.state.readText('files.xml');
  const blocks = [...xml.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].filter((m) => m[2].includes(`<contenthash>${oldHash}</contenthash>`));
  if (!blocks.length) throw new PatchError('invariant', `Ninguna entrada de files.xml usa el blob ${oldHash}.`);
  for (const m of blocks.reverse()) {
    const start = m.index ?? 0;
    const body = m[2];
    const tagv = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(body)?.[1] ?? null;
    let nb = body.split(`<contenthash>${oldHash}</contenthash>`).join(`<contenthash>${nh}</contenthash>`);
    nb = setTag(nb, 'filesize', String(data.length));
    if (mimetype) nb = setTag(nb, 'mimetype', mimetype);
    const blk = `<file id="${m[1]}">${nb}</file>`;
    xml = xml.slice(0, start) + blk + xml.slice(start + m[0].length);
    const fc: FileChange = {
      fileId: Number(m[1]), filename: tagv('filename') ?? '', component: tagv('component') ?? '', filearea: tagv('filearea') ?? '',
      before: { contenthash: oldHash, filesize: Number(tagv('filesize') ?? 0), mimetype: tagv('mimetype') },
      after: { contenthash: nh, filesize: data.length, mimetype: mimetype ?? tagv('mimetype') },
    };
    r.files.push(fc);
  }
  ctx.state.write('files.xml', xml);
  if (!r.entriesModified.includes('files.xml')) r.entriesModified.push('files.xml');
  if (!xml.includes(`<contenthash>${oldHash}</contenthash>`)) {
    const oEntry = blobPath(oldHash);
    if (ctx.state.has(oEntry)) { ctx.state.remove(oEntry); r.entriesRemoved.push(oEntry); }
  }
  return nh;
}

/** Cambia el valor de `<t>…</t>` (la primera) por concatenación. */
export function setTag(xml: string, t: string, value: string): string {
  const open = `<${t}>`;
  const i = xml.indexOf(open);
  if (i < 0) return xml;
  const j = xml.indexOf(`</${t}>`, i);
  if (j < 0) return xml;
  return xml.slice(0, i + open.length) + value + xml.slice(j);
}

export function noteModified(ctx: OpContext, entry: string): void {
  if (!ctx.report.entriesModified.includes(entry)) ctx.report.entriesModified.push(entry);
}
