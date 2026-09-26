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
    // Fix round 1 (M2): todos los frames de una parte comparten el formato del
    // primero; un cambio de versión/sample rate/canales a mitad de stream es fatal.
    const ref = frames[0];
    if (ref && (frame.version !== ref.version || frame.sampleRate !== ref.sampleRate || frame.channels !== ref.channels)) {
      throw new Mp3InvalidError(
        `el formato cambia a mitad del stream en offset ${offset}: ${frame.version}/${frame.sampleRate}Hz/${frame.channels}ch ` +
          `≠ ${ref.version}/${ref.sampleRate}Hz/${ref.channels}ch del primer frame`,
      );
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

/** Frames de AUDIO (sin el frame Xing/Info inicial, que es un placeholder). */
export function audioFramesOf(parsed: ParsedMp3): Mp3Frame[] {
  return parsed.hasXing ? parsed.frames.slice(1) : parsed.frames;
}

/**
 * Duración MEDIDA en segundos: siempre la suma de los frames de audio realmente
 * presentes (fix round 1, I3). El conteo declarado por un header Xing/Info se
 * ignora: un MP3 truncado que sigue terminando en borde de frame mentiría.
 * Todos los frames comparten formato (lo exige parseMp3), así que la suma es
 * exacta: frames × samples / sampleRate.
 */
export function mp3DurationSeconds(buf: Buffer): number {
  const parsed = parseMp3(buf);
  const audio = audioFramesOf(parsed);
  if (audio.length === 0) throw new Mp3InvalidError('el MP3 solo tiene el frame Xing/Info, sin audio');
  return (audio.length * audio[0].samples) / audio[0].sampleRate;
}
