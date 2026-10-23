/**
 * mp3-frame.ts
 *
 * Parseo de un único header de frame MPEG Layer III (4 bytes) en el offset
 * dado. Puro: no lanza para "no hay más frames" (devuelve null), pero sí
 * describe con detalle por qué un header con sync válido es inválido, para
 * que `parseMp3` pueda fallar fuerte con un mensaje útil.
 */

import { BITRATE_KBPS_LAYER3, LAYER_III_BITS, SAMPLE_RATE_HZ, VERSION_BY_BITS, channelsFromModeBits, samplesPerFrameLayer3 } from './mp3-tables';

export interface Mp3Frame {
  offset: number;
  length: number;
  version: 'MPEG1' | 'MPEG2' | 'MPEG2.5';
  layer: 'III';
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  samples: number;
  /** true si este frame es un frame Xing/Info (placeholder, no audio real) */
  isXingOrInfo: boolean;
  /** número de frames declarado por el header Xing/Info, si isXingOrInfo */
  xingFrameCount?: number;
}

// NOTA: se evita a propósito una unión discriminada (`{ok:true,...} | {ok:false,...}`)
// porque este repo compila con `strictNullChecks: false` (tsconfig.json), y con esa
// flag apagada TypeScript NO angosta el tipo tras `if (!result.ok)` (queda como la
// unión completa) — probado: revierte a "Property 'reason' does not exist on type
// '{ok:true;...}'". Un solo shape con campos opcionales evita depender de narrowing.
export interface FrameParseResult {
  ok: boolean;
  frame?: Mp3Frame;
  reason?: string;
}

/** true si en `buf[offset..offset+2)` hay un sync word de 11 bits (0xFF Exx). */
export function hasFrameSync(buf: Buffer, offset: number): boolean {
  if (offset + 1 >= buf.length) return false;
  return buf[offset] === 0xff && (buf[offset + 1] & 0xe0) === 0xe0;
}

/**
 * Intenta parsear un frame Layer III en `offset`. No lanza: devuelve
 * `{ok:false, reason}` para que el caller decida (fin de stream vs. basura).
 */
export function parseFrameHeader(buf: Buffer, offset: number): FrameParseResult {
  if (offset + 4 > buf.length) {
    return { ok: false, reason: `faltan bytes para un header completo en offset ${offset}` };
  }
  if (!hasFrameSync(buf, offset)) {
    return { ok: false, reason: `sync word inválido en offset ${offset}` };
  }

  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;

  const version = VERSION_BY_BITS[versionBits];
  if (!version) {
    return { ok: false, reason: `versión MPEG reservada (bits=${versionBits}) en offset ${offset}` };
  }
  if (layerBits !== LAYER_III_BITS) {
    return { ok: false, reason: `layer no soportado (bits=${layerBits}, solo Layer III) en offset ${offset}` };
  }

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  const channelModeBits = (b3 >> 6) & 0x03;

  const bitrateKbps = BITRATE_KBPS_LAYER3[version][bitrateIndex];
  if (bitrateIndex === 0 || bitrateKbps === -1) {
    return { ok: false, reason: `bitrate index inválido (${bitrateIndex}, "free"/"bad") en offset ${offset}` };
  }

  const sampleRate = SAMPLE_RATE_HZ[version][sampleRateIndex];
  if (sampleRate === -1) {
    return { ok: false, reason: `sample rate index reservado (${sampleRateIndex}) en offset ${offset}` };
  }

  const samples = samplesPerFrameLayer3(version);
  const channels = channelsFromModeBits(channelModeBits);

  // FrameLength = floor((samplesPerFrame/8) * bitrate_bps / sampleRate) + padding
  const length = Math.floor(((samples / 8) * (bitrateKbps * 1000)) / sampleRate) + padding;
  if (length <= 4) {
    return { ok: false, reason: `largo de frame inválido (${length}) en offset ${offset}` };
  }
  if (offset + length > buf.length) {
    return { ok: false, reason: `frame trunco: requiere ${length} bytes desde ${offset}, quedan ${buf.length - offset}` };
  }

  // Xing/Info: aparece en el primer frame, en el lugar del side-info, cuando
  // el encoder describe el stream completo (frame placeholder, sin audio real).
  const sideInfoSize = channels === 1 ? (version === 'MPEG1' ? 17 : 9) : version === 'MPEG1' ? 32 : 17;
  // protection_bit = 0 → hay un CRC de 2 bytes tras el header (fix round 1, M2).
  const crcBytes = (b1 & 0x01) === 0 ? 2 : 0;
  const xingOffset = offset + 4 + crcBytes + sideInfoSize;
  let isXingOrInfo = false;
  let xingFrameCount: number | undefined;
  if (xingOffset + 8 <= offset + length && xingOffset + 8 <= buf.length) {
    const tag = buf.toString('ascii', xingOffset, xingOffset + 4);
    if (tag === 'Xing' || tag === 'Info') {
      isXingOrInfo = true;
      const flags = buf.readUInt32BE(xingOffset + 4);
      if (flags & 0x01) {
        // FRAMES flag: el conteo de frames viene 4 bytes después
        const framesFieldOffset = xingOffset + 8;
        if (framesFieldOffset + 4 <= buf.length) {
          xingFrameCount = buf.readUInt32BE(framesFieldOffset);
        }
      }
    }
  }

  return {
    ok: true,
    frame: { offset, length, version, layer: 'III', bitrateKbps, sampleRate, channels, samples, isXingOrInfo, xingFrameCount },
  };
}
