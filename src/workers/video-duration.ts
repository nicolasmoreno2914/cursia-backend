// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 — duración medida de un video (para `video_interactions`, R11a).
// Puro: sin I/O, sin reloj. Prioridad de fuentes:
//   1. un campo de duración en el status de Videogen (si el proveedor lo trae);
//   2. la caja `mvhd` del MP4 (timescale + duration; versión 0 y 1), si el
//      llamador tiene los bytes;
//   3. `contentDetails.duration` (ISO 8601) de YouTube videos.list, SOLO si ya
//      se obtuvo (nunca se agrega una llamada nueva a YouTube).
// Sin ninguna → { durationSec: null, durationSource: 'unknown' } (R11a falla el
// claim con VIDEO_DURATION_MISSING, sin gasto).
// ─────────────────────────────────────────────────────────────────────────────

export type VideoDurationSource = 'videogen_status' | 'mp4_mvhd' | 'youtube_content_details' | 'unknown';

export interface VideoDuration {
  durationSec: number | null;
  durationSource: VideoDurationSource;
}

/**
 * Duración de la fixture de video de los runs MOCK (el video IdwOipZAeqY que
 * usan R8/R11a y el E2E): 7:48 = 468 s. El Videogen mock la devuelve en su status.
 */
export const MOCK_VIDEO_DURATION_SEC = 468;

/**
 * RF-b fix I3: rango plausible de un video de capítulo. Fuera de él la
 * duración se descarta (null + 'unknown'): una unidad equivocada (ms, minutos)
 * nunca llega a R11a como segundos.
 */
export const MIN_VIDEO_DURATION_SEC = 5;
export const MAX_VIDEO_DURATION_SEC = 7200;

/**
 * Campos del status de Videogen con UNIDAD EXPLÍCITA. El genérico `duration`
 * (unidad desconocida) NO se acepta.
 */
const VIDEOGEN_SECONDS_FIELDS = ['duration_seconds', 'duration_sec', 'durationSec', 'durationSeconds'] as const;
const VIDEOGEN_MS_FIELDS = ['duration_ms', 'durationMs'] as const;

function toNumber(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Segundos enteros dentro de [MIN, MAX]; si no, null. */
export function plausibleSeconds(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  const s = Math.round(n);
  return s >= MIN_VIDEO_DURATION_SEC && s <= MAX_VIDEO_DURATION_SEC ? s : null;
}

export function durationFromVideogenStatus(status: unknown): number | null {
  if (!status || typeof status !== 'object') return null;
  const s = status as Record<string, unknown>;
  for (const f of VIDEOGEN_SECONDS_FIELDS) {
    if (s[f] === undefined || s[f] === null) continue;
    return plausibleSeconds(s[f]);
  }
  for (const f of VIDEOGEN_MS_FIELDS) {
    if (s[f] === undefined || s[f] === null) continue;
    const ms = toNumber(s[f]);
    return ms === null ? null : plausibleSeconds(ms / 1000);
  }
  return null;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

function boxType(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Recorre las cajas de [start, end) y devuelve el rango del contenido de la primera `type`. */
function findBox(b: Uint8Array, start: number, end: number, type: string): { start: number; end: number } | null {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return null;
      size = u64(b, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) return null;
    if (boxType(b, o + 4) === type) return { start: o + header, end: o + size };
    o += size;
  }
  return null;
}

/**
 * Duración en segundos (entero, redondeado) desde `moov/mvhd` de un MP4.
 * mvhd v0: version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)
 * mvhd v1: version(1) flags(3) creation(8) modification(8) timescale(4) duration(8)
 * null si no hay moov/mvhd, la caja está truncada o timescale/duration no son válidos.
 */
export function parseMp4DurationSec(bytes: Uint8Array): number | null {
  if (!bytes || typeof bytes.length !== 'number') return null;
  const moov = findBox(bytes, 0, bytes.length, 'moov');
  if (!moov) return null;
  const mvhd = findBox(bytes, moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;
  const version = bytes[mvhd.start];
  let timescale: number;
  let duration: number;
  if (version === 0) {
    if (mvhd.start + 20 > mvhd.end) return null;
    timescale = u32(bytes, mvhd.start + 12);
    duration = u32(bytes, mvhd.start + 16);
  } else if (version === 1) {
    if (mvhd.start + 32 > mvhd.end) return null;
    timescale = u32(bytes, mvhd.start + 20);
    duration = u64(bytes, mvhd.start + 24);
  } else {
    return null;
  }
  if (!timescale || !duration || duration === 0xffffffff) return null;
  return plausibleSeconds(duration / timescale);
}

/** ISO 8601 de YouTube (`PT7M48S`, `PT1H2M`, `P0DT0H0M5S`) → segundos. */
export function parseIso8601DurationSec(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const s = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
  return plausibleSeconds(s);
}

export function resolveVideoDuration(src: {
  videogenStatus?: unknown;
  mp4Bytes?: Uint8Array | null;
  youtubeContentDetailsDuration?: string | null;
}): VideoDuration {
  const vg = durationFromVideogenStatus(src.videogenStatus);
  if (vg !== null) return { durationSec: vg, durationSource: 'videogen_status' };
  if (src.mp4Bytes) {
    const mp4 = parseMp4DurationSec(src.mp4Bytes);
    if (mp4 !== null) return { durationSec: mp4, durationSource: 'mp4_mvhd' };
  }
  const yt = parseIso8601DurationSec(src.youtubeContentDetailsDuration ?? null);
  if (yt !== null) return { durationSec: yt, durationSource: 'youtube_content_details' };
  return { durationSec: null, durationSource: 'unknown' };
}
