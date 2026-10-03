/**
 * Cursia r19 (bloque L): logo de la marca de agua y la portada del Libro Guía en PDF.
 *
 * Prioridad (DIAG-L §3):
 *   1. logo de la cuenta / institución (`brand_profiles.palette.logoUrl` activo de la institución del curso,
 *      si no `user_settings.logo_b64` del dueño; ambos son un data URI que el frontend guarda TAL CUAL subió
 *      el archivo: PNG, JPEG o SVG, sin convertir);
 *   2. logo oficial de Cursia incluido en el repo (`assets/brand/cursia-logo-navy.png`, RGBA con transparencia).
 *
 * Validación (nunca en silencio): data URI base64 de imagen, mime declarado = bytes mágicos, PNG que
 * decodifica de verdad (decodificador propio, 8 bits) o JPEG con estructura completa (SOI … SOF … SOS … EOI).
 * SVG, GIF, WebP, URL remota, bytes basura o una imagen truncada → logo de Cursia + aviso
 * `libro_logo_invalid:<origen>:<motivo>` en el resumen del paquete. Un logo sin transparencia se usa igual
 * (a baja opacidad se ve como un rectángulo tenue) y deja el aviso `libro_logo_no_alpha:<origen>`.
 *
 * Fix round 1 (I1): además de la validación propia, el logo se EMBEBE de prueba en un documento pdfkit descartable
 * (el mismo parser que usará el Libro): si pdfkit no lo acepta (p.ej. un JPEG válido con bytes de relleno 0xFF entre
 * segmentos, que el parser de pdfkit no soporta) → Cursia + `libro_logo_invalid:<origen>:pdf_embed_unsupported`.
 * SVG: limitación conocida (sin rasterizador en producción: @napi-rs/canvas solo llega transitivo vía pdf-parse y
 * ningún código de src lo importa) → Cursia + aviso.
 *
 * Puro salvo la lectura (cacheada) del asset de Cursia. Determinístico: mismos bytes → mismo PNG canónico.
 */
import PDFDocument = require('pdfkit');
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { inflateSync } from 'zlib';
import { encodePngFiltered, downscaleCoverPng } from './png-downscale';

/** Asset oficial (copiado de logos_finales_cursia/out/logo-navy.png, 560×211 RGBA). */
export const CURSIA_LOGO_PATH = path.resolve(__dirname, '../../../assets/brand/cursia-logo-navy.png');

export type LibroLogoSource = 'brand_profile' | 'user_settings' | 'cursia_default';

/** Logo candidato de la cuenta tal como sale de la base (sin validar). */
export interface LibroLogoCandidate {
  source: 'brand_profile' | 'user_settings';
  /** data URI (`data:image/png;base64,…`) o, si no lo es, el valor crudo (se rechaza con motivo). */
  dataUri: string;
}

export interface ResolvedLibroLogo {
  source: LibroLogoSource;
  kind: 'png' | 'jpeg';
  /** Bytes que se embeben en el PDF (PNG canónico de 8 bits, o el JPEG tal cual). */
  bytes: Buffer;
  width: number;
  height: number;
  hasAlpha: boolean;
  /** sha256 de `bytes`: entra en la clave de reuse del paquete (un cambio de logo re-empaqueta). */
  sha256: string;
  /** Avisos visibles (vacío si el logo de la cuenta se usó sin reparos, o si no había logo). */
  warnings: string[];
}

/** Límites del logo de la cuenta (el frontend acepta hasta 4 MB). */
export const LIBRO_LOGO_LIMITS = { maxBytes: 4.5 * 1024 * 1024, minSide: 32, maxSide: 8000, maxPixels: 8_000_000, maxEmbedWidth: 1200 } as const;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let cursiaCache: ResolvedLibroLogo | null = null;

/** Logo de Cursia (validado con el mismo camino que el de la cuenta; si el asset falta o se rompe, falla fuerte). */
export function cursiaDefaultLogo(): ResolvedLibroLogo {
  if (cursiaCache) return { ...cursiaCache, warnings: [] };
  let raw: Buffer;
  try {
    raw = readFileSync(CURSIA_LOGO_PATH);
  } catch (err) {
    throw new Error(`LIBRO_LOGO_ASSET_MISSING: no se pudo leer ${CURSIA_LOGO_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const v = validateLogoBytes(raw, 'image/png');
  if (v.ok === false) throw new Error(`LIBRO_LOGO_ASSET_INVALID: el logo de Cursia no valida (${v.reason})`);
  if (!v.hasAlpha) throw new Error('LIBRO_LOGO_ASSET_INVALID: el logo de Cursia debe tener transparencia');
  cursiaCache = { source: 'cursia_default', kind: v.kind, bytes: v.bytes, width: v.width, height: v.height, hasAlpha: v.hasAlpha, sha256: sha256(v.bytes), warnings: [] };
  return { ...cursiaCache, warnings: [] };
}

export type LogoValidation =
  | { ok: true; kind: 'png' | 'jpeg'; bytes: Buffer; width: number; height: number; hasAlpha: boolean }
  | { ok: false; reason: string };

/** Parsea un data URI de imagen. Devuelve el mime declarado y los bytes, o un motivo de rechazo. */
export function parseLogoDataUri(value: string): { ok: true; mime: string; bytes: Buffer } | { ok: false; reason: string } {
  // fix round 1 (M3): tope ANTES de cualquier regex / Buffer (4,5 MB en base64 ≈ 6,2 M caracteres + cabecera).
  if (typeof value === 'string' && value.length > Math.ceil((LIBRO_LOGO_LIMITS.maxBytes * 4) / 3) + 256) return { ok: false, reason: 'too_large' };
  const v = String(value ?? '').trim();
  if (!v) return { ok: false, reason: 'empty' };
  if (/^https?:\/\//i.test(v)) return { ok: false, reason: 'remote_url_unsupported' };
  const m = /^data:([a-z0-9.+/-]+)?((?:;[a-z0-9=._-]+)*?);base64,([\s\S]*)$/i.exec(v);
  if (!m) return { ok: false, reason: 'not_base64_data_uri' };
  const mime = (m[1] || '').toLowerCase();
  if (mime === 'image/svg+xml' || mime === 'image/svg') return { ok: false, reason: 'svg_unsupported' };
  if (!/^image\/(png|jpeg|jpg|pjpeg)$/.test(mime)) return { ok: false, reason: `mime_unsupported_${mime.replace(/[^a-z0-9]+/g, '_') || 'none'}` };
  const b64 = m[3].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { ok: false, reason: 'bad_base64' };
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, mime: mime === 'image/png' ? 'image/png' : 'image/jpeg', bytes };
}

/**
 * Estructura completa de un JPEG: SOI, segmentos con longitudes válidas, un SOF baseline/extendido/progresivo
 * (C0/C1/C2) con 1 o 3 componentes, al menos un SOS con sus datos y EOI. Un archivo truncado no llega a EOI.
 */
export function inspectJpeg(b: Buffer): { ok: true; width: number; height: number; components: number } | { ok: false; reason: string } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return { ok: false, reason: 'jpeg_bad_magic' };
  let off = 2;
  let sof: { width: number; height: number; components: number } | null = null;
  let scans = 0;
  while (off < b.length) {
    if (b[off] !== 0xff) return { ok: false, reason: 'jpeg_bad_marker' };
    while (off < b.length && b[off] === 0xff) off++; // relleno 0xFF
    if (off >= b.length) break;
    const marker = b[off++];
    if (marker === 0xd9) {
      if (!sof) return { ok: false, reason: 'jpeg_no_sof' };
      if (!scans) return { ok: false, reason: 'jpeg_no_scan' };
      return { ok: true, ...sof };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (off + 2 > b.length) return { ok: false, reason: 'jpeg_truncated' };
    const len = b.readUInt16BE(off);
    if (len < 2 || off + len > b.length) return { ok: false, reason: 'jpeg_truncated' };
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) return { ok: false, reason: 'jpeg_sof_unsupported' };
      if (len < 8) return { ok: false, reason: 'jpeg_truncated' };
      const height = b.readUInt16BE(off + 3);
      const width = b.readUInt16BE(off + 5);
      const components = b[off + 7];
      if (components !== 1 && components !== 3) return { ok: false, reason: `jpeg_components_${components}_unsupported` };
      if (!width || !height) return { ok: false, reason: 'jpeg_zero_size' };
      sof = { width, height, components };
    }
    off += len;
    if (marker === 0xda) {
      scans++;
      // datos entropía: hasta el próximo marcador que no sea relleno (FF00) ni RST (FFD0-D7)
      while (off < b.length) {
        if (b[off] === 0xff && off + 1 < b.length && b[off + 1] !== 0x00 && !(b[off + 1] >= 0xd0 && b[off + 1] <= 0xd7)) break;
        off++;
      }
      if (off >= b.length - 1) return { ok: false, reason: 'jpeg_truncated' };
    }
  }
  return { ok: false, reason: 'jpeg_truncated' };
}

// ─── Fix round 2 (M1): decodificador PNG completo para logos ──────────────

const ADAM7: ReadonlyArray<[number, number, number, number]> = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function paethP(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export class LogoPngError extends Error {}

/**
 * Fix round 2 (M1): PNG de logo en CUALQUIER forma estándar — profundidad 1/2/4/8/16, tipos de color 0/2/3/4/6,
 * entrelazado Adam7 y transparencia tRNS (gris, RGB o por índice) — a RGB/RGBA de 8 bits (16 bits → byte alto).
 * Síncrono y acotado: el inflado tiene `maxOutputLength` = tamaño exacto esperado (guarda anti bomba de
 * descompresión). Lo usa la validación del logo para producir el PNG canónico de 8 bits que se embebe: así pdfkit nunca
 * toma su camino asíncrono de png-js con bytes de la cuenta (ahí un error se lanza dentro del callback de zlib, fuera de
 * todo try/catch, y tumbaría el proceso del worker).
 */
export function decodeLogoPng(buf: Buffer): { width: number; height: number; channels: 3 | 4; pixels: Buffer } {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new LogoPngError('png_bad_magic');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) throw new LogoPngError('png_truncated');
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      if (len < 13) throw new LogoPngError('png_bad_ihdr');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) throw new LogoPngError('png_bad_ihdr');
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!width || !height) throw new LogoPngError('png_no_ihdr');
  if (width * height > LIBRO_LOGO_LIMITS.maxPixels || Math.max(width, height) > LIBRO_LOGO_LIMITS.maxSide) throw new LogoPngError('too_many_pixels');
  const spp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const okDepth = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>)[colorType];
  if (!spp || !okDepth || !okDepth.includes(depth)) throw new LogoPngError(`png_bad_format_${colorType}_${depth}`);
  if (interlace !== 0 && interlace !== 1) throw new LogoPngError('png_bad_interlace');
  if (colorType === 3 && (!palette || palette.length < 3)) throw new LogoPngError('png_no_palette');
  if (!idat.length) throw new LogoPngError('png_no_data');
  const bitsPP = spp * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const passes = interlace === 1
    ? ADAM7.map(([x0, y0, dx, dy]) => ({ x0, y0, dx, dy, w: Math.max(0, Math.ceil((width - x0) / dx)), h: Math.max(0, Math.ceil((height - y0) / dy)) }))
    : [{ x0: 0, y0: 0, dx: 1, dy: 1, w: width, h: height }];
  const expected = passes.reduce((s, p) => s + (p.w && p.h ? (Math.ceil((p.w * bitsPP) / 8) + 1) * p.h : 0), 0);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    throw new LogoPngError(/ERR_BUFFER_TOO_LARGE|maxOutputLength|larger than/i.test(String((err as Error)?.message ?? err)) ? 'png_bomb' : 'png_undecodable');
  }
  if (raw.length < expected) throw new LogoPngError('png_truncated');
  // muestras por píxel en profundidad original (≤ 16 bits), en orden de imagen
  const samples = new Uint16Array(width * height * spp);
  let pos = 0;
  for (const p of passes) {
    if (!p.w || !p.h) continue;
    const stride = Math.ceil((p.w * bitsPP) / 8);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < p.h; y++) {
      const ft = raw[pos++];
      const line = Buffer.from(raw.subarray(pos, pos + stride));
      pos += stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) v += paethP(a, b, c);
        else if (ft !== 0) throw new LogoPngError(`png_bad_filter_${ft}`);
        line[x] = v & 0xff;
      }
      prev = line;
      const iy = p.y0 + y * p.dy;
      for (let x = 0; x < p.w; x++) {
        const ix = p.x0 + x * p.dx;
        const base = (iy * width + ix) * spp;
        for (let k = 0; k < spp; k++) {
          const si = x * spp + k;
          let v: number;
          if (depth === 16) v = line.readUInt16BE(si * 2);
          else if (depth === 8) v = line[si];
          else {
            const bit = si * depth;
            v = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
          }
          samples[base + k] = v;
        }
      }
    }
  }
  const max = (1 << depth) - 1;
  const to8 = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : null;
  const trnsRgb = colorType === 2 && trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  const hasAlpha = colorType === 4 || colorType === 6 || !!(trns && trns.length && (colorType === 3 || trnsGray !== null || trnsRgb !== null));
  const channels: 3 | 4 = hasAlpha ? 4 : 3;
  const px = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    const s = i * spp;
    let r: number, g: number, b: number, al = 255;
    if (colorType === 0) {
      r = g = b = to8(samples[s]);
      if (trnsGray !== null && samples[s] === trnsGray) al = 0;
    } else if (colorType === 2) {
      r = to8(samples[s]); g = to8(samples[s + 1]); b = to8(samples[s + 2]);
      if (trnsRgb && samples[s] === trnsRgb[0] && samples[s + 1] === trnsRgb[1] && samples[s + 2] === trnsRgb[2]) al = 0;
    } else if (colorType === 3) {
      const idx = samples[s];
      if (!palette || idx * 3 + 2 >= palette.length) throw new LogoPngError('png_bad_palette_index');
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) al = trns[idx];
    } else if (colorType === 4) {
      r = g = b = to8(samples[s]); al = to8(samples[s + 1]);
    } else {
      r = to8(samples[s]); g = to8(samples[s + 1]); b = to8(samples[s + 2]); al = to8(samples[s + 3]);
    }
    px[i * channels] = r;
    px[i * channels + 1] = g;
    px[i * channels + 2] = b;
    if (channels === 4) px[i * 4 + 3] = al;
  }
  return { width, height, channels, pixels: px };
}

/**
 * Fix round 1 (I1): embebido de prueba con el parser real de pdfkit (documento descartable, página 10×10 pt). El JPEG
 * se copia tal cual al PDF (embed síncrono); el PNG es el canónico propio (8 bits). Ancho/alto de pdfkit deben coincidir
 * con los propios (sin rotación EXIF: el Libro dibuja con ignoreOrientation).
 */
export function pdfkitAccepts(bytes: Buffer, width: number, height: number): boolean {
  try {
    const d = new PDFDocument({ autoFirstPage: false, compress: false });
    d.on('data', () => undefined);
    d.on('error', () => undefined);
    const img: any = (d as any).openImage(bytes);
    if (!img || img.width !== width || img.height !== height) return false;
    d.addPage({ size: [10, 10], margin: 0 });
    d.image(img, 0, 0, { width: 10, height: 10, ignoreOrientation: true } as any);
    d.end();
    return true;
  } catch {
    return false;
  }
}

/** Valida bytes de logo contra el mime declarado. PNG → PNG canónico (RGB/RGBA 8 bits, ≤ 1200 px de ancho). */
export function validateLogoBytes(bytes: Buffer, declaredMime: string): LogoValidation {
  const L = LIBRO_LOGO_LIMITS;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > L.maxBytes) return { ok: false, reason: 'too_large' };
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC);
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  // fix round 1 (M2): el olfateo de SVG solo si no hay firma PNG/JPEG (un PNG con «<svg» en su tEXt es un PNG).
  if (!isPng && !isJpeg && /<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('latin1'))) return { ok: false, reason: 'svg_unsupported' };
  if (declaredMime === 'image/png' && !isPng) return { ok: false, reason: isJpeg ? 'mime_mismatch' : 'png_bad_magic' };
  if (declaredMime === 'image/jpeg' && !isJpeg) return { ok: false, reason: isPng ? 'mime_mismatch' : 'jpeg_bad_magic' };
  if (isPng) {
    if (bytes.length < 33) return { ok: false, reason: 'png_truncated' };
    const w = bytes.readUInt32BE(16);
    const h = bytes.readUInt32BE(20);
    if (Math.min(w, h) < L.minSide) return { ok: false, reason: 'too_small' };
    if (Math.max(w, h) > L.maxSide || w * h > L.maxPixels) return { ok: false, reason: 'too_many_pixels' };
    // fix round 2 (M1): cualquier PNG estándar (entrelazado, 16 bits, 1/2/4 bits, tRNS) → canónico 8 bits; el embebido de
    // prueba en pdfkit (abajo) sigue siendo la validación final. Solo un PNG realmente roto (o una bomba) se rechaza.
    let dec;
    try {
      dec = decodeLogoPng(bytes);
    } catch (err) {
      return { ok: false, reason: err instanceof LogoPngError ? err.message : 'png_undecodable' };
    }
    const canonical = encodePngFiltered(dec.width, dec.height, dec.channels, dec.pixels);
    const out = dec.width > L.maxEmbedWidth ? downscaleCoverPng(canonical, L.maxEmbedWidth) : { png: canonical, width: dec.width, height: dec.height };
    if (!pdfkitAccepts(out.png, out.width, out.height)) return { ok: false, reason: 'pdf_embed_unsupported' };
    return { ok: true, kind: 'png', bytes: out.png, width: out.width, height: out.height, hasAlpha: dec.channels === 4 };
  }
  if (isJpeg) {
    const j = inspectJpeg(bytes);
    if (j.ok === false) return { ok: false, reason: j.reason };
    if (Math.min(j.width, j.height) < L.minSide) return { ok: false, reason: 'too_small' };
    if (Math.max(j.width, j.height) > L.maxSide || j.width * j.height > L.maxPixels) return { ok: false, reason: 'too_many_pixels' };
    if (!pdfkitAccepts(bytes, j.width, j.height)) return { ok: false, reason: 'pdf_embed_unsupported' };
    return { ok: true, kind: 'jpeg', bytes, width: j.width, height: j.height, hasAlpha: false };
  }
  return { ok: false, reason: 'unknown_format' };
}

/**
 * Logo del Libro Guía: el de la cuenta si valida; si no (o si no hay), el de Cursia. Un rechazo deja el
 * aviso `libro_logo_invalid:<origen>:<motivo>` (nunca una marca de agua vacía, nunca en silencio).
 */
const resolveCache = new Map<string, ResolvedLibroLogo>();
const RESOLVE_CACHE_MAX = 32;

export function resolveLibroLogo(candidate: LibroLogoCandidate | null | undefined): ResolvedLibroLogo {
  if (!candidate || candidate.dataUri == null || String(candidate.dataUri).trim() === '') return cursiaDefaultLogo();
  // fix round 1 (M4): prepare (cada chequeo de frescura) y el builder resuelven el mismo logo → caché por hash de la entrada.
  const key = `${candidate.source}|${createHash('sha256').update(String(candidate.dataUri)).digest('hex')}`;
  const hit = resolveCache.get(key);
  if (hit) return { ...hit, warnings: [...hit.warnings] };
  const r = resolveLibroLogoUncached(candidate);
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.delete(resolveCache.keys().next().value as string);
  resolveCache.set(key, r);
  return { ...r, warnings: [...r.warnings] };
}

function resolveLibroLogoUncached(candidate: LibroLogoCandidate): ResolvedLibroLogo {
  const fail = (reason: string): ResolvedLibroLogo => ({ ...cursiaDefaultLogo(), warnings: [`libro_logo_invalid:${candidate.source}:${reason}`] });
  const p = parseLogoDataUri(candidate.dataUri);
  if (p.ok === false) return fail(p.reason);
  const v = validateLogoBytes(p.bytes, p.mime);
  if (v.ok === false) return fail(v.reason);
  return {
    source: candidate.source,
    kind: v.kind,
    bytes: v.bytes,
    width: v.width,
    height: v.height,
    hasAlpha: v.hasAlpha,
    sha256: sha256(v.bytes),
    warnings: v.hasAlpha ? [] : [`libro_logo_no_alpha:${candidate.source}`],
  };
}
