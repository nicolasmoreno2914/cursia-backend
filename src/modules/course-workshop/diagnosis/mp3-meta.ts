/**
 * r107 B3 · Taller de cursos — metadatos de un MP3 SIN decodificarlo (T08): salta el ID3v2, lee el PRIMER header de
 * frame (`parseFrameHeader` del pipeline de audio, el mismo que usa el empaquetado) y, si ese frame es Xing/Info, su
 * conteo de frames. Duración:
 *   - con Xing/Info: frames × muestras / frecuencia (lo que declara el encoder; se contrasta con los bytes: si el
 *     archivo tiene menos bytes de los que esos frames necesitan, está CORTADO);
 *   - sin Xing/Info: estimación CBR = bytes de audio × 8 / bitrate.
 * Nunca recorre la cadena de frames entera (eso es `mp3DurationSeconds`, para paquetes propios en el builder).
 */
import { parseFrameHeader } from '../../../package/audio/mp3-frame';

export interface Mp3Meta {
  ok: boolean;
  /** Motivo en español si `ok` es false. */
  problem: string | null;
  durationSeconds: number | null;
  /** 'xing' = declarado por el frame Xing/Info; 'cbr_estimate' = bytes / bitrate. */
  durationMethod: 'xing' | 'cbr_estimate' | null;
  bitrateKbps: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** true si los frames declarados por Xing no caben en los bytes del archivo (archivo cortado). */
  truncated: boolean;
}

/** Tamaño del header ID3v2 (sync-safe), o 0 si no empieza con «ID3». Misma regla que mp3-parser.ts. */
function id3v2Size(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  const footer = (buf[5] & 0x10) !== 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size + (footer ? 10 : 0);
}

const bad = (problem: string): Mp3Meta => ({ ok: false, problem, durationSeconds: null, durationMethod: null, bitrateKbps: null, sampleRate: null, channels: null, truncated: false });

/** `buf` = el archivo entero (o al menos el ID3 + el primer frame); `totalBytes` = su tamaño real. */
export function mp3Meta(buf: Buffer, totalBytes = buf.length): Mp3Meta {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return bad('el archivo de audio está vacío');
  const id3 = id3v2Size(buf);
  if (id3 >= totalBytes) return bad('el archivo de audio solo tiene la etiqueta ID3, sin sonido');
  // Algunos encoders dejan ceros entre el ID3 y el primer frame (mp3-parser los tolera igual): se buscan hasta 64 KB.
  let off = id3;
  const limit = Math.min(buf.length - 4, id3 + 65536);
  while (off <= limit && !(buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0)) {
    if (buf[off] !== 0x00) return bad('no es un MP3 válido (no se encontró el inicio del audio)');
    off++;
  }
  const r = parseFrameHeader(buf, off);
  if (!r.ok || !r.frame) return bad(`no es un MP3 válido (${r.reason ?? 'primer frame ilegible'})`);
  const f = r.frame;
  const id3v1 = totalBytes === buf.length && buf.length >= 128 && buf.toString('ascii', buf.length - 128, buf.length - 125) === 'TAG' ? 128 : 0;
  const audioBytes = totalBytes - off - id3v1;
  if (f.isXingOrInfo && f.xingFrameCount) {
    const seconds = (f.xingFrameCount * f.samples) / f.sampleRate;
    // Bytes que necesitan los frames declarados (frame medio ≈ bitrate medio = bytes / duración; con CBR, exacto).
    // Un archivo cortado tiene MUCHO menos audio que el declarado: se exige al menos el 90 %.
    const frameLen = Math.floor(((f.samples / 8) * f.bitrateKbps * 1000) / f.sampleRate);
    const avgKbps = seconds > 0 ? Math.round((audioBytes * 8) / seconds / 1000) : f.bitrateKbps;
    const expected = f.xingFrameCount * frameLen;
    const truncated = avgKbps < f.bitrateKbps * 0.5 && audioBytes < expected * 0.9;
    return { ok: true, problem: null, durationSeconds: seconds, durationMethod: 'xing', bitrateKbps: avgKbps || f.bitrateKbps, sampleRate: f.sampleRate, channels: f.channels, truncated };
  }
  const seconds = (audioBytes * 8) / (f.bitrateKbps * 1000);
  return { ok: true, problem: null, durationSeconds: seconds, durationMethod: 'cbr_estimate', bitrateKbps: f.bitrateKbps, sampleRate: f.sampleRate, channels: f.channels, truncated: false };
}
