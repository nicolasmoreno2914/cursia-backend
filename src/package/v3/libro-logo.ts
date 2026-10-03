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
import { decodePng, encodePngFiltered, downscaleCoverPng, PngUnsupportedError } from './png-downscale';

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
    let dec;
    try {
      dec = decodePng(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: err instanceof PngUnsupportedError ? `png_unsupported:${msg.replace(/^PNG_UNSUPPORTED:\s*/, '').slice(0, 60)}` : 'png_undecodable' };
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
