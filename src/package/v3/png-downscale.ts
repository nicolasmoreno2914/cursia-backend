/**
 * Cursia V2.1 — R12: reducción de la portada de Gamma (review G5, concern 2).
 *
 * Con `forceclean=1` HTMLPurifier descarta `width`/`max-width` del `<img>` de
 * la tarjeta de presentación: la portada se muestra a su tamaño natural. Una
 * portada de Gamma (~1920 px) desborda cualquier label. Reducir la imagen a
 * ≤ `COVER_MAX_WIDTH` px acota el daño (en Boost el label tiene
 * `.no-overflow`) y además achica el .mbz (§Q.7).
 *
 * Decodificador/encodificador PNG propio (sin dependencias): 8 bits, sin
 * entrelazado, tipos de color 0/2/3/4/6. Filtro de caja (promedio por área).
 * Determinístico: mismos bytes de entrada → mismos bytes de salida.
 * Una PNG fuera de ese subconjunto NO se modifica (se devuelve tal cual con
 * `reason`): el paquete sigue siendo correcto, solo más pesado; el empaque lo
 * reporta como aviso visible.
 */
import { inflateSync } from 'zlib';
import { PNG_SIGNATURE, encodePng } from './synthetic-media';

export const COVER_MAX_WIDTH = 640;

export interface DecodedPng {
  width: number;
  height: number;
  /** 3 = RGB, 4 = RGBA. */
  channels: 3 | 4;
  pixels: Buffer;
}

export class PngUnsupportedError extends Error {
  readonly code = 'PNG_UNSUPPORTED';
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodifica una PNG 8-bit no entrelazada a RGB/RGBA. Lanza PngUnsupportedError fuera de ese subconjunto. */
export function decodePng(buf: Buffer): DecodedPng {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngUnsupportedError('PNG_UNSUPPORTED: firma PNG inválida');
  }
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
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!width || !height) throw new PngUnsupportedError('PNG_UNSUPPORTED: sin IHDR');
  if (depth !== 8) throw new PngUnsupportedError(`PNG_UNSUPPORTED: profundidad ${depth} (solo 8 bits)`);
  if (interlace !== 0) throw new PngUnsupportedError('PNG_UNSUPPORTED: entrelazada');
  const spp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!spp) throw new PngUnsupportedError(`PNG_UNSUPPORTED: tipo de color ${colorType}`);
  if (colorType === 3 && !palette) throw new PngUnsupportedError('PNG_UNSUPPORTED: paleta ausente');
  if (width * height > 40_000_000) throw new PngUnsupportedError('PNG_UNSUPPORTED: imagen demasiado grande');
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (width * spp + 1) * height + 1 });
  const stride = width * spp;
  if (raw.length < (stride + 1) * height) throw new PngUnsupportedError('PNG_UNSUPPORTED: datos truncados');
  const img = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= spp ? img[dst + x - spp] : 0;
      const b = y > 0 ? img[dst - stride + x] : 0;
      const c = x >= spp && y > 0 ? img[dst - stride + x - spp] : 0;
      let out: number;
      if (ft === 0) out = v;
      else if (ft === 1) out = v + a;
      else if (ft === 2) out = v + b;
      else if (ft === 3) out = v + ((a + b) >> 1);
      else if (ft === 4) out = v + paeth(a, b, c);
      else throw new PngUnsupportedError(`PNG_UNSUPPORTED: filtro ${ft}`);
      img[dst + x] = out & 0xff;
    }
  }
  const hasAlpha = colorType === 4 || colorType === 6 || (colorType === 3 && !!trns);
  const channels: 3 | 4 = hasAlpha ? 4 : 3;
  const px = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    let r: number, g: number, b: number, al = 255;
    if (colorType === 0) r = g = b = img[i];
    else if (colorType === 2) { r = img[i * 3]; g = img[i * 3 + 1]; b = img[i * 3 + 2]; }
    else if (colorType === 3) {
      const idx = img[i];
      if (!palette || idx * 3 + 2 >= palette.length) throw new PngUnsupportedError('PNG_UNSUPPORTED: índice fuera de la paleta');
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) al = trns[idx];
    } else if (colorType === 4) { r = g = b = img[i * 2]; al = img[i * 2 + 1]; }
    else { r = img[i * 4]; g = img[i * 4 + 1]; b = img[i * 4 + 2]; al = img[i * 4 + 3]; }
    px[i * channels] = r;
    px[i * channels + 1] = g;
    px[i * channels + 2] = b;
    if (channels === 4) px[i * 4 + 3] = al;
  }
  return { width, height, channels, pixels: px };
}

/** Promedio por área (filtro de caja) a `tw`×`th`. */
function boxResample(src: DecodedPng, tw: number, th: number): Buffer {
  const { width: sw, height: sh, channels: ch, pixels } = src;
  const out = Buffer.alloc(tw * th * ch);
  const acc = new Float64Array(ch);
  for (let ty = 0; ty < th; ty++) {
    const y0 = (ty * sh) / th;
    const y1 = ((ty + 1) * sh) / th;
    for (let tx = 0; tx < tw; tx++) {
      const x0 = (tx * sw) / tw;
      const x1 = ((tx + 1) * sw) / tw;
      acc.fill(0);
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const p = (sy * sw + sx) * ch;
          for (let c = 0; c < ch; c++) acc[c] += pixels[p + c] * w;
          area += w;
        }
      }
      const o = (ty * tw + tx) * ch;
      for (let c = 0; c < ch; c++) out[o + c] = Math.min(255, Math.max(0, Math.round(acc[c] / area)));
    }
  }
  return out;
}

export interface CoverDownscaleResult {
  png: Buffer;
  width: number;
  height: number;
  /** true si se reescribió la imagen. */
  downscaled: boolean;
  /** Motivo por el que se dejó igual (ya era chica, o formato no soportado). */
  reason?: string;
}

/**
 * Reduce la portada a ≤ `maxWidth` px de ancho conservando la proporción. Si
 * ya entra, o si la PNG usa un formato fuera del subconjunto soportado, se
 * devuelve sin tocar (con `reason`). Nunca lanza por el formato.
 */
export function downscaleCoverPng(buf: Buffer, maxWidth = COVER_MAX_WIDTH): CoverDownscaleResult {
  let dec: DecodedPng;
  try {
    dec = decodePng(buf);
  } catch (err) {
    if (err instanceof PngUnsupportedError) {
      const w = buf.length >= 24 ? buf.readUInt32BE(16) : 0;
      const h = buf.length >= 24 ? buf.readUInt32BE(20) : 0;
      return { png: buf, width: w, height: h, downscaled: false, reason: err.message };
    }
    throw err;
  }
  if (dec.width <= maxWidth) return { png: buf, width: dec.width, height: dec.height, downscaled: false, reason: 'already_small' };
  const tw = maxWidth;
  const th = Math.max(1, Math.round((dec.height * tw) / dec.width));
  const px = boxResample(dec, tw, th);
  return { png: encodePng(tw, th, dec.channels, px), width: tw, height: th, downscaled: true };
}
