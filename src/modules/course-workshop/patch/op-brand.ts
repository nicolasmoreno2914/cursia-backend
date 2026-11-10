/**
 * r107 B4 · `brand_replace` — logo y colores de la marca.
 *
 * Logo: el logo ACTUAL se identifica por el sha1 de sus BYTES (B5 lo elige con `listBrandImages`). Se reemplaza en:
 *   - todo blob de `files/` con esos bytes → blob nuevo + TODAS las entradas de files.xml que lo usaban (hash, tamaño);
 *     el tipo tiene que coincidir (un `logo.png` no pasa a ser un JPEG con el mismo nombre);
 *   - toda imagen embebida `data:image/…;base64,…` con esos bytes en los campos HTML (actividades, secciones) y en el
 *     Libro Guía HTML (portada / marca de agua de `buildLibroHTML`).
 *   El PDF del Libro v3 lleva el logo dibujado dentro: no se puede cambiar sin regenerarlo → aviso de desalineación.
 * Colores: `#hex viejo → #hex nuevo` SOLO dentro de atributos `style="…"` de las etiquetas de los campos HTML (nunca
 *   en texto visible, nunca en el JS / HTML de un SCORM, nunca en el CSS del Libro). Un color pedido que no aparece hace
 *   fallar la operación (el plan se armó con otro paquete).
 */
import { xmlUnescape } from '../../visual-design/preview-extract';
import { WorkshopHtmlField } from '../course-model';
import { sha1Of } from './container';
import { locateField, rawIndexMap, writeField, xmlEsc } from './html-edit';
import { OpContext, blobPath, noteModified, replaceBlob } from './op-context';
import { BrandReplaceOp, PatchError } from './types';

const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/svg+xml', test: (b) => /^\s*(<\?xml[\s\S]{0,200}?)?(<!--[\s\S]*?-->\s*)*<svg\b/i.test(b.subarray(0, 600).toString('utf8')) },
];
const mimeOf = (b: Buffer): string | null => MAGIC.find((m) => m.test(b))?.mime ?? null;
const DATA_URI = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/gi;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const norm6 = (h: string) => { const x = h.slice(1).toLowerCase(); return x.length === 3 ? x.split('').map((c) => c + c).join('') : x; };

/** Imágenes que pueden ser el logo: blobs de imagen y data URI de los campos HTML, con dónde aparecen (para B5). */
export interface BrandImage { sha1: string; mimetype: string | null; bytes: number; places: string[] }

/** Lista las imágenes del paquete (blobs de imagen + embebidas en HTML), más usadas primero. Puro sobre el inventario. */
export function listBrandImages(inv: { activities: Array<{ dir: string; html: WorkshopHtmlField[]; files: Array<{ contenthash: string; filename: string; mimetype: string | null; filesize: number; filearea: string }> }> }): BrandImage[] {
  const m = new Map<string, BrandImage>();
  const add = (sha1: string, mimetype: string | null, bytes: number, place: string) => {
    const x = m.get(sha1) ?? { sha1, mimetype, bytes, places: [] };
    if (!x.places.includes(place)) x.places.push(place);
    m.set(sha1, x);
  };
  for (const a of inv.activities) {
    for (const f of a.files) if (/^image\//.test(f.mimetype ?? '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.filename)) add(f.contenthash, f.mimetype, f.filesize, `${a.dir}/${f.filearea}/${f.filename}`);
    for (const h of a.html) for (const d of h.html.matchAll(DATA_URI)) { const b = Buffer.from(d[2].replace(/\s+/g, ''), 'base64'); add(sha1Of(b), d[1], b.length, `${a.dir} (${h.field})`); }
  }
  return [...m.values()].sort((x, y) => y.places.length - x.places.length || (x.sha1 < y.sha1 ? -1 : 1));
}

/** Reemplaza en un HTML (desescapado) los data URI cuyo contenido es el logo actual. Devuelve [html nuevo, cuántos]. */
function swapDataUris(html: string, currentSha1: string, uri: string): { out: string; n: number } {
  let n = 0;
  let out = '';
  let last = 0;
  for (const d of html.matchAll(DATA_URI)) {
    const b = Buffer.from(d[2].replace(/\s+/g, ''), 'base64');
    if (sha1Of(b) !== currentSha1) continue;
    out += html.slice(last, d.index) + uri;
    last = (d.index ?? 0) + d[0].length;
    n++;
  }
  return { out: out + html.slice(last), n };
}

/** Cambia colores solo dentro de `style="…"` / `style='…'` de etiquetas. Devuelve ediciones sobre el HTML desescapado. */
function colorEdits(html: string, map: Map<string, string>, used: Map<string, number>): Array<{ start: number; end: number; ins: string }> {
  const edits: Array<{ start: number; end: number; ins: string }> = [];
  // Fix round 1 (P2-5): el texto de <script>/<style> y los comentarios se tapan (mismo largo) antes de buscar etiquetas:
  // un `'<div style="color:#…">'` dentro de un script o de un comentario no es un atributo y no se toca.
  const masked = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, (m) => ' '.repeat(m.length));
  for (const t of masked.matchAll(/<[a-zA-Z][^<>]*>/g)) {
    const tagStart = t.index ?? 0;
    for (const s of t[0].matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const val = s[1] ?? s[2] ?? '';
      const valStart = tagStart + (s.index ?? 0) + s[0].indexOf(val, s[0].indexOf('=') + 1);
      for (const c of val.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g)) {
        const k = norm6(c[0]);
        const to = map.get(k);
        if (!to) continue;
        used.set(k, (used.get(k) ?? 0) + 1);
        const st = valStart + (c.index ?? 0);
        edits.push({ start: st, end: st + c[0].length, ins: to });
      }
    }
  }
  return edits;
}

export async function applyBrandReplace(ctx: OpContext, op: BrandReplaceOp): Promise<void> {
  if (!op.logo && !op.colors) throw new PatchError('invalid_params', 'brand_replace sin logo ni colores.');
  const r = ctx.report;
  const parts: string[] = [];
  let logoUri: string | null = null;
  let logoBytes: Buffer | null = null;
  let logoMime: string | null = null;
  if (op.logo) {
    if (!/^[0-9a-f]{40}$/.test(op.logo.currentSha1 ?? '')) throw new PatchError('invalid_params', 'logo.currentSha1 tiene que ser el sha1 (40 hex) del logo actual.');
    const b64 = String(op.logo.image?.base64 ?? '').replace(/\s+/g, '');
    if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new PatchError('invalid_params', 'La imagen nueva no es base64.');
    logoBytes = Buffer.from(b64, 'base64');
    logoMime = mimeOf(logoBytes);
    if (!logoMime || logoMime !== op.logo.image.mimetype) throw new PatchError('invalid_content', `La imagen nueva no es un ${op.logo.image.mimetype} (sus bytes dicen ${logoMime ?? 'otra cosa'}).`);
    if (sha1Of(logoBytes) === op.logo.currentSha1) throw new PatchError('invalid_params', 'La imagen nueva es igual al logo actual.');
    logoUri = `data:${logoMime};base64,${logoBytes.toString('base64')}`;
  }
  const colorMap = new Map<string, string>();
  for (const [from, to] of Object.entries(op.colors ?? {})) {
    if (!HEX.test(from) || !HEX.test(to)) throw new PatchError('invalid_params', `Color inválido: ${from} → ${to} (formato #rgb o #rrggbb).`);
    colorMap.set(norm6(from), to);
  }
  const used = new Map<string, number>();
  let logoCount = 0;

  // 1. Campos HTML (actividades y secciones): data URI del logo + colores en style="".
  const fields: Array<{ f: WorkshopHtmlField; moduleId: number | null; sectionId: number | null; scorm: boolean }> = [
    ...ctx.inv.activities.flatMap((a) => a.html.filter((h) => h.field !== 'externalurl').map((f) => ({ f, moduleId: a.moduleId, sectionId: null, scorm: a.modname === 'scorm' }))),
    ...ctx.inv.sections.flatMap((s) => s.html.map((f) => ({ f, moduleId: null, sectionId: s.id, scorm: false }))),
  ];
  // Varios campos pueden vivir en la misma entrada (book): de atrás hacia adelante para que los desplazamientos sigan valiendo.
  fields.sort((x, y) => (x.f.entry < y.f.entry ? -1 : x.f.entry > y.f.entry ? 1 : y.f.rawOffset - x.f.rawOffset));
  for (const { f, moduleId, sectionId } of fields) {
    let edits: Array<{ start: number; end: number; ins: string }> = [];
    if (colorMap.size) edits = colorEdits(f.html, colorMap, used);
    let n = 0;
    if (logoUri && op.logo) {
      for (const d of f.html.matchAll(DATA_URI)) {
        if (sha1Of(Buffer.from(d[2].replace(/\s+/g, ''), 'base64')) !== op.logo.currentSha1) continue;
        edits.push({ start: d.index ?? 0, end: (d.index ?? 0) + d[0].length, ins: logoUri });
        n++;
      }
    }
    if (!edits.length) continue;
    logoCount += n;
    const loc = await locateField(ctx.state, f);
    const map = rawIndexMap(loc.raw);
    let raw = loc.raw;
    for (const e of edits.sort((x, y) => y.start - x.start)) raw = raw.slice(0, map[e.start]) + xmlEsc(e.ins) + raw.slice(map[e.end]);
    writeField(ctx.state, loc, raw);
    noteModified(ctx, loc.entry);
    r.fields.push({ entry: loc.entry, field: f.field, moduleId, sectionId, before: f.html, after: xmlUnescape(raw), beforeRawSha1: f.rawSha1, afterRawSha1: sha1Of(raw) });
  }

  // 2. Blobs con los bytes del logo (y data URI dentro del Libro Guía HTML).
  if (op.logo && logoBytes) {
    const blobs = new Map<string, { mimetype: string | null; names: string[] }>();
    // Fix round 1 (P2-5): los SCORM no se tocan (su área content se vuelve a extraer del zip del área package): un blob
    // del logo que use un SCORM se cuenta y se avisa, no se reemplaza; si el mismo blob lo usa también otra actividad,
    // no se puede reemplazar solo para ella (es el mismo archivo) → la operación falla con motivo.
    const scormUse = ctx.raw.allFiles.filter(({ file }) => file.contenthash === op.logo!.currentSha1 && file.component === 'mod_scorm');
    const otherUse = ctx.raw.allFiles.filter(({ file }) => file.contenthash === op.logo!.currentSha1 && file.component !== 'mod_scorm');
    if (scormUse.length && otherUse.length) throw new PatchError('unsupported', `El logo actual es el MISMO archivo en un juego SCORM y en ${otherUse.length} lugar(es) más: no se puede cambiar fuera del SCORM sin tocar el SCORM (que no se modifica).`);
    if (scormUse.length) r.misalignment.push(`${scormUse.length} archivo(s) de juegos SCORM tienen el logo anterior y no se tocan (el SCORM no se modifica).`);
    for (const { file } of otherUse) {
      const x = blobs.get(file.contenthash) ?? { mimetype: file.mimetype, names: [] };
      x.names.push(file.filename);
      blobs.set(file.contenthash, x);
    }
    for (const [h, x] of blobs) {
      if (!ctx.state.has(blobPath(h))) throw new PatchError('target_not_found', `El blob del logo (${h}) no viene en el paquete.`);
      if (x.mimetype && x.mimetype !== logoMime) throw new PatchError('invalid_content', `El logo actual es ${x.mimetype} (${x.names.join(', ')}): la imagen nueva tiene que ser del mismo tipo (es ${logoMime}).`);
      await replaceBlob(ctx, h, logoBytes);
      logoCount += x.names.length;
    }
    for (const a of ctx.inv.activities.filter((y) => y.kind === 'libro' && y.modname === 'resource')) {
      for (const lf of a.files.filter((y) => y.filearea === 'content' && /\.html?$/i.test(y.filename))) {
        if (!ctx.state.has(blobPath(lf.contenthash))) continue;
        const html = (await ctx.state.read(blobPath(lf.contenthash))).toString('utf8');
        const sw = swapDataUris(html, op.logo.currentSha1, logoUri as string);
        if (!sw.n) continue;
        await replaceBlob(ctx, lf.contenthash, Buffer.from(sw.out, 'utf8'));
        logoCount += sw.n;
        r.notes.push(`Libro Guía (${lf.filename}): ${sw.n} imagen(es) del logo reemplazada(s)`);
      }
      if (a.files.some((y) => y.filearea === 'content' && /\.pdf$/i.test(y.filename))) {
        r.misalignment.push('El PDF del Libro Guía lleva el logo dibujado adentro y no se puede regenerar desde el paquete: conserva el logo anterior.');
      }
    }
    if (!logoCount) throw new PatchError('target_not_found', `El logo actual (${op.logo.currentSha1.slice(0, 10)}…) no aparece en el paquete: nada que reemplazar.`);
    parts.push(`logo reemplazado en ${logoCount} lugar(es)`);
    if (ctx.inv.activities.some((a) => a.modname === 'scorm') && !scormUse.length) r.misalignment.push('Los juegos SCORM no se tocan: si llevan el logo dentro de su paquete, conservan el anterior.');
  }
  const missing = [...colorMap.keys()].filter((k) => !used.get(k));
  if (missing.length) throw new PatchError('target_not_found', `Los colores ${missing.map((k) => `#${k}`).join(', ')} no aparecen en ningún style="" del curso.`);
  if (colorMap.size) parts.push(`colores: ${[...colorMap.entries()].map(([k, v]) => `#${k} → ${v} (${used.get(k)})`).join(', ')}`);
  r.summary = `Marca: ${parts.join('; ')}`;
}
