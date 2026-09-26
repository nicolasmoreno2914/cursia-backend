/**
 * R9 — dimensiones de un PNG, puro: solo lee la firma + el chunk IHDR
 * (siempre el primero, siempre 13 bytes de datos), sin decodificar píxeles.
 * https://www.w3.org/TR/png/#11IHDR
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngDimensionsUnknownError extends Error {
  readonly code = 'PNG_DIMENSIONS_UNKNOWN';
  constructor(reason: string) {
    super(`PNG_DIMENSIONS_UNKNOWN: ${reason}`);
    this.name = 'PngDimensionsUnknownError';
  }
}

export interface PngDimensions {
  width: number;
  height: number;
}

export function pngDimensions(buf: Buffer): PngDimensions {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 8 + 13) {
    throw new PngDimensionsUnknownError('buffer demasiado chico para tener firma + IHDR');
  }
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngDimensionsUnknownError('firma PNG inválida');
  }
  // Byte 8-11: longitud del primer chunk (BE). Byte 12-15: tipo ("IHDR").
  const chunkType = buf.toString('latin1', 12, 16);
  if (chunkType !== 'IHDR') {
    throw new PngDimensionsUnknownError(`el primer chunk es "${chunkType}", no IHDR`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new PngDimensionsUnknownError(`dimensiones inválidas en IHDR (${width}x${height})`);
  }
  return { width, height };
}
