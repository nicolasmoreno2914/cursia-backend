/**
 * r74 — plan de ENTREGA del curso para Moodle según la capacidad real (no solo el tamaño total).
 *
 * Antes (r61 Q-24) un curso cuyo `.mbz` proyectado superaba el límite de subida del almacenamiento se bloqueaba en la
 * «Estimación de producción», aunque se pudiera entregar de otra forma (#87: 30 capítulos, ≈ 278 MiB, 78 % audiolibro).
 * Ahora la entrega se elige así:
 *   - `single`: todo cabe en UN archivo de a lo sumo `partMaxBytes` → el `.mbz` de siempre (bytes idénticos);
 *   - `parts`:  «Paquete principal + partes de audio» — el principal trae el curso completo SIN el MP3 del audiolibro;
 *               el audiolibro va por módulo en partes `.mbz` (cada una ≤ `partMaxBytes`) que se restauran DENTRO del
 *               mismo curso («Combinar la copia de seguridad con este curso»).
 * Bloquea SOLO si ninguna entrega es posible: el principal (sin audio) no cabe en el almacenamiento, un segmento de audio
 * indivisible (un capítulo) no cabe en una parte, o harían falta más partes que `maxParts`.
 *
 * Límites (bytes):
 *   - `storageMaxBytes`: tope por objeto del almacenamiento (`packageSizeLimitsFromEnv().maxBytes`).
 *   - `partMaxBytes`: tamaño máximo de cada archivo entregado — `PACKAGE_PART_MAX_BYTES` o, sin la variable,
 *     min(200 MiB, storageMaxBytes). Nunca mayor que `storageMaxBytes`. Es también el umbral de `single`.
 *   - `maxParts`: partes de audio como máximo — `PACKAGE_MAX_AUDIO_PARTS` (default 20).
 * Puro: sin I/O, sin reloj.
 */
import { PACKAGE_SIZE_CONFIG_INVALID } from './package-size-budget';

export const PACKAGE_PART_MAX_BYTES_ENV = 'PACKAGE_PART_MAX_BYTES';
export const PACKAGE_MAX_AUDIO_PARTS_ENV = 'PACKAGE_MAX_AUDIO_PARTS';
const MIB = 1024 * 1024;
/** 200 MiB: entra en el límite de 300 MB de Storage y en Moodle con `upload_max_filesize` ≥ 256M. */
export const DEFAULT_PACKAGE_PART_MAX_BYTES = 200 * MIB;
export const DEFAULT_PACKAGE_MAX_AUDIO_PARTS = 20;
/** Reserva por parte para su XML (moodle_backup, files, labels): una parte real de 6 segmentos ronda 60 KB. */
export const AUDIO_PART_OVERHEAD_BYTES = 512 * 1024;
/** Mínimo razonable de una parte (bajo esto el plan sería absurdo: config mal puesta). */
export const MIN_PACKAGE_PART_BYTES = 8 * MIB;
export const PACKAGE_DELIVERY_PLAN_VERSION = 'r74-v1';

export interface DeliveryLimits {
  storageMaxBytes: number;
  partMaxBytes: number;
  maxParts: number;
}

function parseIntEnv(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const t = raw.trim();
  if (!/^[1-9][0-9]*$/.test(t) || !Number.isSafeInteger(Number(t))) throw new Error(`${PACKAGE_SIZE_CONFIG_INVALID}: ${name}="${raw}" no es un entero positivo`);
  return Number(t);
}

/** Límites de entrega desde el entorno (fail loud con un valor inválido o una parte mayor que el almacenamiento). */
export function deliveryLimitsFromEnv(storageMaxBytes: number, env: Record<string, string | undefined> = process.env): DeliveryLimits {
  if (!Number.isSafeInteger(storageMaxBytes) || storageMaxBytes <= 0) throw new Error(`${PACKAGE_SIZE_CONFIG_INVALID}: límite de almacenamiento inválido (${storageMaxBytes})`);
  const part = parseIntEnv(PACKAGE_PART_MAX_BYTES_ENV, env[PACKAGE_PART_MAX_BYTES_ENV]);
  if (part !== null && part > storageMaxBytes) throw new Error(`${PACKAGE_SIZE_CONFIG_INVALID}: ${PACKAGE_PART_MAX_BYTES_ENV} (${part}) > límite del almacenamiento (${storageMaxBytes})`);
  if (part !== null && part < MIN_PACKAGE_PART_BYTES) throw new Error(`${PACKAGE_SIZE_CONFIG_INVALID}: ${PACKAGE_PART_MAX_BYTES_ENV} (${part}) < ${MIN_PACKAGE_PART_BYTES}`);
  const maxParts = parseIntEnv(PACKAGE_MAX_AUDIO_PARTS_ENV, env[PACKAGE_MAX_AUDIO_PARTS_ENV]) ?? DEFAULT_PACKAGE_MAX_AUDIO_PARTS;
  return { storageMaxBytes, partMaxBytes: part ?? Math.min(DEFAULT_PACKAGE_PART_MAX_BYTES, storageMaxBytes), maxParts };
}

// ─── Segmentación del audiolibro (bytes reales o estimados) ────────────────

export interface AudioChapterSize {
  chapterId: string;
  moduleId: string;
  bytes: number;
}

export interface AudioPartPlan {
  /** 2..N+1 (el paquete principal es el archivo 1). */
  partNumber: number;
  bytes: number;
  segments: Array<{ moduleId: string; chapterIds: string[]; bytes: number }>;
}

export type AudioPartsResult =
  | { ok: true; parts: AudioPartPlan[] }
  | { ok: false; reason: 'chapter_over_part' | 'too_many_parts'; detail: string };

/**
 * Segmentos = capítulos consecutivos de UN módulo (en el orden del curso); un módulo que no cabe en una parte se corta en
 * tramos de capítulos. Las partes se llenan en orden con segmentos enteros (≤ partMaxBytes − overhead). Determinístico.
 */
export function planAudioParts(chapters: readonly AudioChapterSize[], limits: Pick<DeliveryLimits, 'partMaxBytes' | 'maxParts'>): AudioPartsResult {
  const cap = limits.partMaxBytes - AUDIO_PART_OVERHEAD_BYTES;
  const segments: Array<{ moduleId: string; chapterIds: string[]; bytes: number }> = [];
  for (const ch of chapters) {
    if (!(ch.bytes > 0)) throw new Error(`planAudioParts: capítulo ${ch.chapterId} sin bytes`);
    if (ch.bytes > cap) return { ok: false, reason: 'chapter_over_part', detail: `el audio del capítulo ${ch.chapterId} (${ch.bytes} B) no cabe en una parte de ${limits.partMaxBytes} B` };
    const last = segments[segments.length - 1];
    if (last && last.moduleId === ch.moduleId && last.bytes + ch.bytes <= cap) {
      last.chapterIds.push(ch.chapterId);
      last.bytes += ch.bytes;
    } else {
      segments.push({ moduleId: ch.moduleId, chapterIds: [ch.chapterId], bytes: ch.bytes });
    }
  }
  const pack = (limit: number): AudioPartPlan[] => {
    const out: AudioPartPlan[] = [];
    for (const sg of segments) {
      const last = out[out.length - 1];
      if (last && last.bytes + sg.bytes <= limit) {
        last.segments.push(sg);
        last.bytes += sg.bytes;
      } else {
        out.push({ partNumber: out.length + 2, bytes: sg.bytes, segments: [sg] });
      }
    }
    return out;
  };
  // Mínimo de partes con el tope; después se reparten PAREJAS (mismo número de partes, tope más bajo): 3 + 3 módulos
  // en vez de 5 + 1. Determinístico.
  let parts = pack(cap);
  const total = segments.reduce((s, x) => s + x.bytes, 0);
  const biggest = segments.reduce((m, x) => Math.max(m, x.bytes), 0);
  for (let limit = Math.max(biggest, Math.ceil(total / parts.length)); limit < cap; limit = Math.ceil(limit * 1.02) + 1) {
    const even = pack(limit);
    if (even.length === parts.length) { parts = even; break; }
  }
  if (parts.length > limits.maxParts) return { ok: false, reason: 'too_many_parts', detail: `harían falta ${parts.length} partes de audio (máximo ${limits.maxParts})` };
  return { ok: true, parts };
}

// ─── Plan de entrega antes de generar (desde la proyección) ────────────────

export interface ProjectedDelivery {
  version: string;
  mode: 'single' | 'audio_apart';
  /**
   * Archivos de la versión AUTOCONTENIDA (1 en single; 1 + partes de audio si no). La entrega recomendada de un curso
   * `audio_apart` es UN solo .mbz con el audiolibro en línea (`linkedAvailable`); la autocontenida queda para portabilidad.
   */
  files: number;
  /** Bytes ALTOS del archivo principal (single: todo; parts: todo menos el audiolibro). */
  mainHighBytes: number;
  /** Bytes ALTOS de cada parte de audio (vacío en single). */
  partHighBytes: number[];
  limits: DeliveryLimits;
  /** ok = entregable; blocked = ninguna entrega es posible (con `blockedReason`). */
  verdict: 'ok' | 'blocked';
  blockedReason: string | null;
  warnings: string[];
  /** Lo completa RunsService: el backend sirve el audiolibro en línea (PUBLIC_MEDIA_BASE_URL configurada). */
  linkedAvailable?: boolean;
}

export const PACKAGE_MAIN_OVER_PART_WARN = 'package_main_over_part_size';

/**
 * Plan con los bytes ALTOS de la proyección (el peor caso razonable). `audiobookChapterHighBytes` en el orden del curso,
 * con su módulo cuando se conoce (sin módulo → todos en uno; solo cambia la cuenta estimada de partes).
 */
export function projectDelivery(
  input: { highBytes: number; audiobookHighBytes: number; audiobookChapterHighBytes: ReadonlyArray<{ chapterId: string; moduleId?: string | null; bytes: number }> },
  limits: DeliveryLimits,
): ProjectedDelivery {
  const base = { version: PACKAGE_DELIVERY_PLAN_VERSION, limits, warnings: [] as string[] };
  if (input.highBytes <= limits.partMaxBytes) {
    return { ...base, mode: 'single', files: 1, mainHighBytes: input.highBytes, partHighBytes: [], verdict: 'ok', blockedReason: null };
  }
  const mainHighBytes = Math.max(0, input.highBytes - input.audiobookHighBytes) + 64 * 1024;
  const chapters = input.audiobookChapterHighBytes.filter((c) => c.bytes > 0).map((c) => ({ chapterId: c.chapterId, moduleId: c.moduleId ?? '_', bytes: Math.round(c.bytes) }));
  const audio = chapters.length ? planAudioParts(chapters, limits) : ({ ok: true, parts: [] } as AudioPartsResult);
  const partHighBytes = audio.ok ? audio.parts.map((p) => p.bytes + AUDIO_PART_OVERHEAD_BYTES) : [];
  const files = 1 + partHighBytes.length;
  let blockedReason: string | null = null;
  if (mainHighBytes > limits.storageMaxBytes) {
    blockedReason = `main_over_storage: el paquete principal sin el audiolibro pesaría hasta ${mainHighBytes} B y el almacenamiento admite ${limits.storageMaxBytes} B por archivo`;
  } else if (audio.ok === false) {
    blockedReason = `${audio.reason}: ${audio.detail}`;
  } else if (!partHighBytes.length) {
    blockedReason = `no_audio_to_split: el curso no cabe en un archivo de ${limits.partMaxBytes} B y no tiene audiolibro que separar`;
  }
  if (!blockedReason && mainHighBytes > limits.partMaxBytes) base.warnings.push(`${PACKAGE_MAIN_OVER_PART_WARN}:${mainHighBytes}:${limits.partMaxBytes}`);
  return { ...base, mode: 'audio_apart', files, mainHighBytes, partHighBytes, verdict: blockedReason ? 'blocked' : 'ok', blockedReason };
}
