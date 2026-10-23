/**
 * mp3-tables.ts
 *
 * Tablas fijas del header de frame MPEG-1/2/2.5 Layer III (ISO/IEC 11172-3 /
 * 13818-3). Solo Layer III porque es lo único que produce nuestro pipeline de
 * TTS (§R10-core) — ver `mp3-frame.ts` para el parseo del header en sí.
 *
 * R10-core es una librería pura: sin I/O, sin reloj, sin aleatoriedad.
 */

export type MpegVersion = 'MPEG1' | 'MPEG2' | 'MPEG2.5';

// version bits (b20-19 del header): 00=MPEG2.5, 01=reservado, 10=MPEG2, 11=MPEG1
export const VERSION_BY_BITS: Record<number, MpegVersion | null> = {
  0b00: 'MPEG2.5',
  0b01: null, // reservado
  0b10: 'MPEG2',
  0b11: 'MPEG1',
};

// layer bits (b18-17 del header): 00=reservado, 01=Layer III, 10=Layer II, 11=Layer I
// Solo soportamos Layer III (valor de bits 0b01); cualquier otro valor es
// MP3_INVALID para este parser porque nuestro TTS nunca emite Layer I/II.
export const LAYER_III_BITS = 0b01;

// Tabla de bitrate (kbps) por versión, Layer III. MPEG2 y MPEG2.5 comparten
// tabla para Layer II/III. Índice 0 = "free" (no soportado aquí), índice 15 = "bad".
export const BITRATE_KBPS_LAYER3: Record<MpegVersion, number[]> = {
  MPEG1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  MPEG2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
  'MPEG2.5': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
};

// Tabla de sample rate (Hz) por versión. Índice 3 = reservado.
export const SAMPLE_RATE_HZ: Record<MpegVersion, number[]> = {
  MPEG1: [44100, 48000, 32000, -1],
  MPEG2: [22050, 24000, 16000, -1],
  'MPEG2.5': [11025, 12000, 8000, -1],
};

// Muestras de audio por frame, Layer III: 1152 en MPEG1, 576 en MPEG2/2.5.
export function samplesPerFrameLayer3(version: MpegVersion): number {
  return version === 'MPEG1' ? 1152 : 576;
}

// channel mode bits (b7-6 del byte 4 del header): 00=stereo,01=joint stereo,
// 10=dual channel, 11=mono. Solo nos importa el conteo de canales.
export function channelsFromModeBits(modeBits: number): number {
  return modeBits === 0b11 ? 1 : 2;
}
