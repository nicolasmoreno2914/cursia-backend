/**
 * mp3-info.ts
 *
 * UX r18 (problema 2): frame Info/Xing para un stream de frames MPEG Layer III
 * ya armado (el audiolibro concatenado). Sin ffmpeg: puro, determinístico.
 *
 * Por qué: `concatMp3` descarta el Info/Xing de cada parte (mentiría sobre el
 * total) y antes no escribía uno nuevo. Sin cabecera, el reproductor estima la
 * duración por bytes/bitrate; con ella, la lee directo (conteo de frames REAL
 * del buffer, nunca un valor declarado por otro lado) y el seek es exacto.
 *
 * Formato (convención LAME/Xing): un frame MPEG válido y silencioso cuyo
 * side-info va en cero, seguido de la etiqueta "Info" (CBR) o "Xing" (VBR),
 * flags = FRAMES|BYTES, el número de frames de AUDIO (sin contar este) y el
 * total de bytes del stream (este frame incluido).
 */

import type { Mp3Frame } from './mp3-frame';
import { BITRATE_KBPS_LAYER3 } from './mp3-tables';
import { Mp3InvalidError } from './mp3-errors';

const FLAG_FRAMES = 0x01;
const FLAG_BYTES = 0x02;

function sideInfoBytes(version: Mp3Frame['version'], channels: number): number {
  return channels === 1 ? (version === 'MPEG1' ? 17 : 9) : version === 'MPEG1' ? 32 : 17;
}

/**
 * Frame Info/Xing para `audioFrames` (en orden), cuyo primer header de 4 bytes
 * es `firstHeader`. `audioBytes` = bytes de audio que van DESPUÉS del frame.
 */
export function buildInfoFrame(firstHeader: Buffer, audioFrames: Mp3Frame[], audioBytes: number): Buffer {
  if (!audioFrames.length) throw new Mp3InvalidError('frame Info: sin frames de audio');
  const ref = audioFrames[0];
  const side = sideInfoBytes(ref.version, ref.channels);
  const need = 4 + side + 16; // header + side-info + etiqueta + flags + frames + bytes
  const table = BITRATE_KBPS_LAYER3[ref.version];
  // El bitrate del propio audio si el frame alcanza; si no (p.ej. 8 kbps), el menor que alcance.
  let idx = table.indexOf(ref.bitrateKbps);
  const lengthAt = (i: number): number => Math.floor(((ref.samples / 8) * table[i] * 1000) / ref.sampleRate);
  while (idx > 0 && idx < 15 && lengthAt(idx) < need) idx++;
  if (idx <= 0 || idx >= 15 || lengthAt(idx) < need) throw new Mp3InvalidError(`frame Info: ningún bitrate alcanza (${ref.version}/${ref.sampleRate}Hz)`);
  const len = lengthAt(idx);
  const frame = Buffer.alloc(len, 0);
  frame[0] = 0xff;
  frame[1] = firstHeader[1] | 0x01; // protection_bit = 1 → sin CRC
  frame[2] = (idx << 4) | (firstHeader[2] & 0x0c) | (firstHeader[2] & 0x01); // bitrate, sample rate, private; padding 0
  frame[3] = firstHeader[3]; // modo de canal / extensión / copyright / original / emphasis
  const cbr = audioFrames.every((f) => f.bitrateKbps === ref.bitrateKbps);
  const at = 4 + side;
  frame.write(cbr ? 'Info' : 'Xing', at, 'ascii');
  frame.writeUInt32BE(FLAG_FRAMES | FLAG_BYTES, at + 4);
  frame.writeUInt32BE(audioFrames.length, at + 8);
  frame.writeUInt32BE(len + audioBytes, at + 12);
  return frame;
}
