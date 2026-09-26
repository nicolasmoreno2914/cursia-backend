/**
 * R9 — fixtures sintéticas puras (sin llamar a ningún proveedor, sin leer
 * disco). Se usan cuando los blobs reales de V1 no están disponibles en el
 * scratch de la sesión (ver fixtures-loader.ts) para que los checks y el
 * mock provider siempre puedan correr, en cualquier máquina.
 */

/** PDF válido mínimo de 1 página, sin comprimir (fácil de leer a ojo). */
export function syntheticOnePagePdf(): Buffer {
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\n' +
    '%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

/** PNG mínimo de 1x1 — firma + IHDR (color truecolor, 8 bits) + IEND. */
export function syntheticOnePxPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = pngChunk('IHDR', ihdrData);

  const iendChunk = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, iendChunk]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  // El lector de este módulo (png-dimensions.ts) no valida el CRC, así que
  // no hace falta calcularlo bien para que las fixtures sean útiles acá;
  // se deja en ceros para no fingir un valor correcto que nadie verifica.
  const crc = Buffer.alloc(4);
  return Buffer.concat([length, typeBuf, data, crc]);
}
