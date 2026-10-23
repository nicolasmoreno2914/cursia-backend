/**
 * Cursia V2.1 — R12: reducción de la portada de Gamma (review G5, concern 2).
 *
 * Historia: en R12 el tope (640 px) era la defensa contra el desborde con
 * `forceclean=1` (HTMLPurifier descarta el `width` CSS del `<img>`). Desde R13
 * esa defensa es el atributo `width="240"` de la tarjeta (card-html.ts), que
 * sobrevive al purificador; el tope ahora solo acota el peso del .mbz (§Q.7)
 * sin bajar de la resolución que pide la pantalla (ver UX r18 abajo).
 *
 * Decodificador/encodificador PNG propio (sin dependencias): 8 bits, sin
 * entrelazado, tipos de color 0/2/3/4/6. Filtro de caja (promedio por área).
 * Determinístico: mismos bytes de entrada → mismos bytes de salida.
 *
 * UX r18 (problema 3): el tope de 640 px dejaba la portada borrosa (se muestra a ~772 px CSS = ~1544 px
 * físicos en pantallas DPR 2). El desborde con forceclean que motivó el tope ya lo cubre el atributo
 * `width="240"` de la tarjeta (R13, card-html.ts), así que el tope sube a 1600 px (raster de 150 dpi =
 * 2000×1125 → 1600×900). Para acotar el peso, la PNG reducida se codifica con filtro adaptativo por fila
 * (heurística estándar de libpng: mínima suma de diferencias absolutas) en vez de sin filtro. Costo medido
 * (rasters reales del #616): 0,52–0,80 MB por portada (antes 0,18–0,22 MB a 640 px): ≈ +1,75 MB en un curso de
 * 4 capítulos, ≈ +4 MB en uno de 9. El v3 no tiene tope de tamaño; el límite práctico es el de subida del Moodle.
 * Una PNG fuera de ese subconjunto NO se modifica (se devuelve tal cual con
 * `reason`): el paquete sigue siendo correcto, solo más pesado; el empaque lo
 * reporta como aviso visible.
 */
import { deflateSync, inflateSync } from 'zlib';
import { PNG_SIGNATURE, pngChunk } from './synthetic-media';

export const COVER_MAX_WIDTH = 1600;

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

/**
 * PNG RGB/RGBA de 8 bits con filtro adaptativo por fila (None/Sub/Up/Average/Paeth; se elige el de
 * menor suma de |byte con signo|, la heurística de libpng). Determinístico. Sin pérdida.
 */
export function encodePngFiltered(width: number, height: number, channels: 3 | 4, pixels: Buffer): Buffer {
  if (pixels.length !== width * height * channels) throw new Error('PNG_ENCODE: tamaño de píxeles inconsistente');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestSum = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      const out = cand[ft];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? row[x - channels] : 0;
        const b = up ? up[x] : 0;
        const c = up && x >= channels ? up[x - channels] : 0;
        const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[x] - pred) & 0xff;
        out[x] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = ft;
      }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
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
  return { png: encodePngFiltered(tw, th, dec.channels, px), width: tw, height: th, downscaled: true };
}
