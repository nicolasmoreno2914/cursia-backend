/**
 * mp3-parser.ts
 *
 * `parseMp3` + `mp3DurationSeconds` — lectura pura de un buffer MP3 (MPEG
 * 1/2/2.5 Layer III) producido por nuestro pipeline de TTS. Sin ffmpeg (no
 * está instalado en el VPS, ver brief r10-core-audio.md): todo el parseo de
 * frames vive en `mp3-frame.ts`.
 *
 * Fail loud: cualquier basura que no sea ID3v2 + cadena válida de frames +
 * ID3v1 opcional lanza `Mp3InvalidError` (código `MP3_INVALID`) — nunca se
 * devuelve una duración o un frame-set parcial en silencio.
 */

import { Mp3Frame, parseFrameHeader } from './mp3-frame';
import { Mp3InvalidError } from './mp3-errors';

export interface ParsedMp3 {
  id3v2Bytes: number;
  frames: Mp3Frame[];
  hasXing: boolean;
  xingFrames?: number;
  trailingBytes: Buffer;
  id3v1: Buffer | null;
}

/** Tamaño del header ID3v2 (sync-safe), o 0 si `buf` no empieza con "ID3". */
function id3v2SizeBytes(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  const flags = buf[5];
  const footerPresent = (flags & 0x10) !== 0;
  const b6 = buf[6] & 0x7f;
  const b7 = buf[7] & 0x7f;
  const b8 = buf[8] & 0x7f;
  const b9 = buf[9] & 0x7f;
  const size = (b6 << 21) | (b7 << 14) | (b8 << 7) | b9;
  return 10 + size + (footerPresent ? 10 : 0);
}

/** Detecta un tag ID3v1 (128 bytes finales que empiezan con "TAG"). */
function id3v1Tag(buf: Buffer): Buffer | null {
  if (buf.length < 128) return null;
  const start = buf.length - 128;
  if (buf.toString('ascii', start, start + 3) !== 'TAG') return null;
  return buf.subarray(start);
}

export function parseMp3(buf: Buffer): ParsedMp3 {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Mp3InvalidError('buffer vacío o no es un Buffer');
  }

  const id3v2Bytes = id3v2SizeBytes(buf);
  if (id3v2Bytes > buf.length) {
    throw new Mp3InvalidError(`header ID3v2 declara ${id3v2Bytes} bytes pero el buffer tiene ${buf.length}`);
  }

  const id3v1 = id3v1Tag(buf);
  const audioEnd = id3v1 ? buf.length - 128 : buf.length;

  const frames: Mp3Frame[] = [];
  let hasXing = false;
  let xingFrames: number | undefined;

  let offset = id3v2Bytes;

  // Saltar basura previa al primer sync (algunos encoders dejan padding de
  // ceros entre el tag ID3v2 y el primer frame). Tolerado solo antes del
  // primer frame válido; una vez dentro de la cadena de frames, cualquier
  // corte de sync es fatal (garantiza que no colamos audio corrupto).
  while (offset < audioEnd && !parseFrameHeaderOk(buf, offset, audioEnd)) {
    if (buf[offset] !== 0x00) {
      throw new Mp3InvalidError(`no se encontró sync de frame válido a partir del offset ${offset} (byte=0x${buf[offset].toString(16)})`);
    }
    offset += 1;
  }

  let firstFrame = true;
  while (offset < audioEnd) {
    const result = parseFrameHeader(buf, offset);
    if (!result.ok || !result.frame) {
      throw new Mp3InvalidError(`${result.reason} (cadena de frames rota tras ${frames.length} frame(s) válidos)`);
    }
    const frame = result.frame;
    if (offset + frame.length > audioEnd) {
      throw new Mp3InvalidError(`frame en offset ${offset} excede el fin de audio (${audioEnd})`);
    }
    if (firstFrame && frame.isXingOrInfo) {
      hasXing = true;
      xingFrames = frame.xingFrameCount;
    }
    frames.push(frame);
    offset += frame.length;
    firstFrame = false;
  }

  if (frames.length === 0) {
    throw new Mp3InvalidError('no se encontró ningún frame de audio válido');
  }

  const trailingBytes = buf.subarray(offset, audioEnd);

  return { id3v2Bytes, frames, hasXing, xingFrames, trailingBytes, id3v1 };
}

function parseFrameHeaderOk(buf: Buffer, offset: number, end: number): boolean {
  if (offset + 4 > end) return false;
  const result = parseFrameHeader(buf, offset);
  return result.ok;
}

/**
 * Duración exacta en segundos. Prefiere el conteo de frames del header
 * Xing/Info cuando está presente (representa el stream completo tal como lo
 * declaró el encoder); si no, suma `samples/sampleRate` de cada frame real.
 */
export function mp3DurationSeconds(buf: Buffer): number {
  const parsed = parseMp3(buf);
  const audioFrames = parsed.hasXing ? parsed.frames.slice(1) : parsed.frames;

  if (parsed.hasXing && typeof parsed.xingFrames === 'number') {
    const ref = parsed.frames[0];
    return (parsed.xingFrames * ref.samples) / ref.sampleRate;
  }

  let totalSeconds = 0;
  for (const frame of audioFrames) {
    totalSeconds += frame.samples / frame.sampleRate;
  }
  return totalSeconds;
}
