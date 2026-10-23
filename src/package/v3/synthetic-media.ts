/**
 * Cursia V2.1 — R12: medios SINTÉTICOS determinísticos para artifacts de
 * proveedor SIMULADOS (mock) que llegan al empaque sin bytes (la fixture de
 * R4 `mockProviderOutput` solo trae JSON: `slideCount`, `durationSeconds`).
 *
 * Solo se usan cuando el run está congelado en `mock` para ese proveedor
 * (`assertNoMockArtifactsForRealPackage` ya lo exigió). Un paquete real nunca
 * pasa por aquí. No es "generar" un artifact pagado: son bytes de relleno,
 * costo cero, marcados como simulados en el resumen del paquete.
 *
 * Puro: sin reloj, sin azar, sin I/O.
 */
import { deflateSync } from 'zlib';

// ─── PDF de N páginas ──────────────────────────────────────────────────────

/**
 * PDF mínimo válido de `pages` páginas en blanco (Catalog → Pages /Count N,
 * xref y trailer correctos): `pdfPageCount` lo resuelve por /Root.
 */
export function syntheticPdf(pages: number): Buffer {
  if (!Number.isInteger(pages) || pages < 1 || pages > 500) {
    throw new Error(`SYNTHETIC_MEDIA_INVALID: pages debe ser un entero en [1, 500] (recibido ${String(pages)})`);
  }
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ─── MP3 de N segundos ─────────────────────────────────────────────────────

/** Formato de los MP3 de TTS reales (R10): MPEG-2 Layer III, 24 kHz, mono. 8 kbps → frames de 24 bytes / 576 muestras. */
const MP3_FRAME_HEADER = Buffer.from([0xff, 0xf3, 0x14, 0xc0]);
const MP3_FRAME_BYTES = 24;
export const SYNTHETIC_MP3_FRAME_SECONDS = 576 / 24000;

/**
 * MP3 CBR silencioso de ≈`seconds` (redondeado al frame): frames MPEG-2 L3
 * 24 kHz mono 8 kbps con el cuerpo en cero. Compatible con `concatMp3` y con
 * los MP3 de TTS del mismo formato. La duración que se muestra siempre es la
 * MEDIDA (`mp3DurationSeconds`) de estos bytes, nunca `seconds`.
 */
export function syntheticMp3(seconds: number): Buffer {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 4 * 3600) {
    throw new Error(`SYNTHETIC_MEDIA_INVALID: seconds debe estar en (0, 14400] (recibido ${String(seconds)})`);
  }
  const frames = Math.max(1, Math.round(seconds / SYNTHETIC_MP3_FRAME_SECONDS));
  const buf = Buffer.alloc(frames * MP3_FRAME_BYTES);
  for (let i = 0; i < frames; i++) MP3_FRAME_HEADER.copy(buf, i * MP3_FRAME_BYTES);
  return buf;
}

// ─── PNG de color sólido ───────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 8-bit (RGB o RGBA) a partir de píxeles crudos, filtro 0, deflate nivel 9 (determinístico). */
export function encodePng(width: number, height: number, channels: 3 | 4, pixels: Buffer): Buffer {
  if (pixels.length !== width * height * channels) throw new Error('PNG_ENCODE: tamaño de píxeles inconsistente');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Portada simulada: PNG RGB de color sólido (hex #RRGGBB). */
export function syntheticCoverPng(width: number, height: number, hex: string): Buffer {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error(`SYNTHETIC_MEDIA_INVALID: color ${hex}`);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
  }
  return encodePng(width, height, 3, px);
}
