/**
 * mp3-concat.ts
 *
 * `concatMp3` — concatenación a nivel de frame (no de bytes crudos) de N
 * partes MP3 en un único stream reproducible. Usado para armar el
 * audiolibro a partir de `audiobook_chapter:<uuid>` (uno por capítulo) sin
 * ffmpeg.
 *
 * Reglas (brief r10-core-audio.md):
 *  - se despoja el ID3 (v2 y v1) de cada parte;
 *  - se exige mismo sample rate + channel mode + versión MPEG en todas las
 *    partes, si no `MP3_INCOMPATIBLE_PARTS` con el detalle de cada una;
 *  - se descarta el frame Xing/Info de cada parte (mentiría sobre el total).
 */

import { parseMp3 } from './mp3-parser';
import { Mp3IncompatiblePartsError, Mp3InvalidError } from './mp3-errors';

interface PartProfile {
  index: number;
  version: string;
  sampleRate: number;
  channels: number;
}

export function concatMp3(parts: Buffer[]): Buffer {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Mp3InvalidError('concatMp3 requiere al menos una parte');
  }

  const parsedParts = parts.map((buf, index) => {
    const parsed = parseMp3(buf);
    const ref = parsed.frames[0];
    const profile: PartProfile = { index, version: ref.version, sampleRate: ref.sampleRate, channels: ref.channels };
    return { parsed, profile };
  });

  const baseline = parsedParts[0].profile;
  const mismatched = parsedParts.filter(
    (p) => p.profile.version !== baseline.version || p.profile.sampleRate !== baseline.sampleRate || p.profile.channels !== baseline.channels,
  );
  if (mismatched.length > 0) {
    const detail = parsedParts.map((p) => p.profile);
    throw new Mp3IncompatiblePartsError(
      `las partes no comparten versión/sample rate/canales: ${JSON.stringify(detail)}`,
      detail as unknown as Array<Record<string, unknown>>,
    );
  }

  const chunks: Buffer[] = [];
  for (let i = 0; i < parsedParts.length; i++) {
    const { parsed } = parsedParts[i];
    const sourceBuf = parts[i];
    const audioFrames = parsed.hasXing ? parsed.frames.slice(1) : parsed.frames;
    for (const frame of audioFrames) {
      chunks.push(sourceBuf.subarray(frame.offset, frame.offset + frame.length));
    }
  }

  return Buffer.concat(chunks);
}
