/**
 * r61 (Q-24) — proyección del tamaño del `.mbz` v3 ANTES de generar (antes de gastar).
 *
 * El presupuesto de tamaño del worker de empaque (`package-size-budget.ts`) mide el paquete YA armado: un curso que no
 * cabe en el límite de subida del almacenamiento falla ahí, después de pagar todo el contenido, el audio y las
 * presentaciones (#1353: 106 MB, 413 EntityTooLarge con el límite de 50 MB). Esta proyección corre en la vista previa
 * del inicio y en `startRun` (run nuevo o reabierto): si el tamaño ALTO supera el límite configurado, el run no se crea
 * ni se reabre (409 con las opciones) — principio de producto: fallar ANTES de gastar. Si el alto cabe pero el
 * ESPERADO está a menos de 10 % del límite, aviso visible.
 *
 * Modelo (bytes del `.mbz` tal como se sube; el zip casi no comprime mp3/pdf/png). Calibrado con el `.mbz` real de
 * #1353 (artifact c2df5f60, 111.561.795 bytes; 12 capítulos de contenido + 3 de práctica):
 *   - audiolibro: 48 kbps mono (AUDIOBOOK_TARGET_BITRATE_KBPS) × minutos por capítulo de contenido.
 *     · Con las palabras narrables del capítulo conocidas (`chapterWords`, la misma base que el estimador de FinOps:
 *       `audiobookPlan.narratableWords`), minutos = palabras × ratio / 141 ppm (AUDIOBOOK_WPM_REF), con el ratio
 *       objetivo 0,9 (esperado) y el máximo aceptado 1,1 (alto).
 *     · Sin palabras (run nuevo): calibración de #1353, que midió 89.906.112 bytes / 12 = 7,49 MiB ≈ 20,8 min por
 *       capítulo (máx. 24 min) → esperado 21 min, alto 25 min.
 *   - bienvenida: 64 kbps; #1353 = 519.360 bytes. Esperado 0,6 MB, alto 1,0 MB.
 *   - presentación por capítulo de contenido (PDF + portada PNG): #1353 media 1,14 MB + 0,56 MB (máx. 1,61 + 0,77).
 *     Esperado 1,75 MB, alto 2,4 MB.
 *   - resto por capítulo (XML de actividades, H5P, PDF de aplicación): #1353 ≈ 0,17 MB. Esperado 0,25 MB, alto 0,4 MB.
 *   - fijo del curso (Libro Guía PDF, preguntas, insignia, manifiesto): #1353 ≈ 0,8 MB. Esperado 1 MB, alto 2 MB.
 *   - video: 0 (va a YouTube no listado; el `.mbz` solo lleva el enlace + el H5P interactivo).
 *   - proveedor en modo mock: medios sintéticos (MP3 silencioso de 8 kbps, PDF en blanco) → 50 KB por item.
 * Unidades: bytes; «MB» en los textos = MiB (1024²). Con la forma de #1353 (12 + 3 capítulos, sin palabras) el modelo da
 * esperado ≈ +4 % y alto ≈ +32 % sobre los 111.561.795 bytes reales (ver check-r61-package-size P1).
 *
 * Puro: sin I/O, sin reloj.
 */
import { AUDIOBOOK_MAX_RATIO, AUDIOBOOK_TARGET_BITRATE_KBPS, AUDIOBOOK_TARGET_RATIO, AUDIOBOOK_WPM_REF } from '../audio/audiobook-policy';
import { PackageSizeLimits } from './package-size-budget';

export const PACKAGE_SIZE_PROJECTED_OVER_LIMIT = 'PACKAGE_SIZE_PROJECTED_OVER_LIMIT';
/** Aviso: el alto cabe, pero el esperado queda a menos de PACKAGE_SIZE_NEAR_LIMIT_RATIO del límite. */
export const PACKAGE_SIZE_PROJECTED_NEAR_LIMIT = 'package_size_projected_near_limit';
export const PACKAGE_SIZE_NEAR_LIMIT_RATIO = 0.9;
export const PACKAGE_SIZE_PROJECTION_VERSION = 'r61-q24-v2';

const MB = 1024 * 1024;
const AUDIO_BYTES_PER_SECOND = (AUDIOBOOK_TARGET_BITRATE_KBPS * 1000) / 8;

export const PACKAGE_SIZE_MODEL = Object.freeze({
  /** Sin palabras conocidas (calibración #1353). */
  audiobookMinutesPerChapter: { expected: 21, high: 25 },
  audiobookRatio: { expected: AUDIOBOOK_TARGET_RATIO, high: AUDIOBOOK_MAX_RATIO },
  welcomeBytes: { expected: 0.6 * MB, high: 1.0 * MB },
  presentationBytesPerChapter: { expected: 1.75 * MB, high: 2.4 * MB },
  otherBytesPerChapter: { expected: 0.25 * MB, high: 0.4 * MB },
  fixedBytes: { expected: 1.0 * MB, high: 2.0 * MB },
  mockMediaBytes: 50 * 1024,
});

export interface ProjectionItem {
  type: string;
  chapterId?: string | null;
}

export interface ProjectionModes {
  presentation: 'mock' | 'real';
  audio: 'mock' | 'real';
}

export interface PackageSizeProjection {
  version: string;
  expectedBytes: number;
  highBytes: number;
  /** Bytes esperados por componente (para el mensaje y la UI). */
  breakdown: { audiobook: number; welcome: number; presentations: number; other: number; fixed: number };
  counts: { contentChapters: number; chapters: number; audiobookChapters: number; presentations: number; audiobookChaptersWithWords: number };
  limitBytes: number | null;
  /** ok = el alto cabe; warn = el alto cabe pero el esperado está a < 10 % del límite; over = el alto no cabe (bloquea). */
  verdict: 'ok' | 'warn' | 'over';
  warnings: string[];
  /** Mensaje accionable (código al inicio) cuando verdict = over. */
  error: string | null;
}

export const mbText = (n: number): string => `${(n / MB).toFixed(1)} MB`;

/** Proyección del `.mbz` desde los items del Manifest v3 y los modos de proveedor congelados para el run. */
export function projectPackageSize(
  items: readonly ProjectionItem[],
  modes: ProjectionModes,
  limits: Pick<PackageSizeLimits, 'maxBytes'>,
  opts: { chapterWords?: Readonly<Record<string, number>> | null } = {},
): PackageSizeProjection {
  if (!Array.isArray(items)) throw new Error('projectPackageSize necesita items[]');
  const M = PACKAGE_SIZE_MODEL;
  const chapters = new Set<string>();
  let contentChapters = 0;
  let audiobookChapters = 0;
  let presentations = 0;
  let welcome = 0;
  const audiobookIds: Array<string | null> = [];
  for (const it of items) {
    if (it.chapterId) chapters.add(String(it.chapterId));
    if (it.type === 'content') contentChapters++;
    else if (it.type === 'audiobook_chapter') { audiobookChapters++; audiobookIds.push(it.chapterId ? String(it.chapterId) : null); }
    else if (it.type === 'presentation') presentations++;
    else if (it.type === 'audio_welcome') welcome++;
  }
  const audioReal = modes.audio !== 'mock';
  const presReal = modes.presentation !== 'mock';
  const wordsOf = (id: string | null): number | null => {
    const w = id ? Number(opts.chapterWords?.[id]) : NaN;
    return Number.isFinite(w) && w > 0 ? w : null;
  };
  const audiobookChaptersWithWords = audiobookIds.filter((id) => wordsOf(id) !== null).length;
  const minutesOf = (id: string | null, k: 'expected' | 'high'): number => {
    const w = wordsOf(id);
    return w === null ? M.audiobookMinutesPerChapter[k] : (w * M.audiobookRatio[k]) / AUDIOBOOK_WPM_REF;
  };
  const at = (k: 'expected' | 'high') => {
    const audiobook = audioReal
      ? audiobookIds.reduce((s, id) => s + minutesOf(id, k) * 60 * AUDIO_BYTES_PER_SECOND, 0)
      : audiobookChapters * M.mockMediaBytes;
    const w = audioReal ? welcome * M.welcomeBytes[k] : welcome * M.mockMediaBytes;
    const pres = presReal ? presentations * M.presentationBytesPerChapter[k] : presentations * M.mockMediaBytes;
    const other = chapters.size * M.otherBytesPerChapter[k];
    const fixed = M.fixedBytes[k];
    return { audiobook: Math.round(audiobook), welcome: Math.round(w), presentations: Math.round(pres), other: Math.round(other), fixed: Math.round(fixed) };
  };
  const e = at('expected');
  const h = at('high');
  const sum = (b: typeof e) => b.audiobook + b.welcome + b.presentations + b.other + b.fixed;
  const expectedBytes = sum(e);
  const highBytes = sum(h);
  const limitBytes = limits.maxBytes ?? null;
  let verdict: PackageSizeProjection['verdict'] = 'ok';
  const warnings: string[] = [];
  let error: string | null = null;
  if (limitBytes !== null && highBytes > limitBytes) {
    verdict = 'over';
    const minutes = Math.round(e.audiobook / AUDIO_BYTES_PER_SECOND / 60);
    const parts = [
      `audiolibro ${mbText(e.audiobook)} (${audiobookChapters} capítulos, ≈ ${minutes} min a ${AUDIOBOOK_TARGET_BITRATE_KBPS} kbps)`,
      `presentaciones ${mbText(e.presentations)}`,
      `resto ${mbText(e.welcome + e.other + e.fixed)}`,
    ].join(', ');
    error =
      `${PACKAGE_SIZE_PROJECTED_OVER_LIMIT}: el paquete para Moodle de este curso pesaría ≈ ${mbText(expectedBytes)} y podría llegar a ` +
      `${mbText(highBytes)}; el límite de subida del almacenamiento configurado es ${mbText(limitBytes)}, así que podría no entregarse ` +
      `después de pagar la generación. Detalle (esperado): ${parts}. No se generó nada ni se gastó. Opciones: ` +
      `(1) un administrador sube el límite de subida de Supabase Storage (plan Pro o superior; Storage → Settings → «Upload file size limit») ` +
      `a ≥ ${mbText(highBytes)} y pone el valor EXACTO en bytes del panel en STORAGE_MAX_UPLOAD_BYTES del backend; ` +
      `(2) reduce el curso (menos capítulos de contenido) en la estructura y vuelve a aprobar.`;
  } else if (limitBytes !== null && expectedBytes > limitBytes * PACKAGE_SIZE_NEAR_LIMIT_RATIO) {
    verdict = 'warn';
    warnings.push(`${PACKAGE_SIZE_PROJECTED_NEAR_LIMIT}:${expectedBytes}:${limitBytes}`);
  }
  return {
    version: PACKAGE_SIZE_PROJECTION_VERSION,
    expectedBytes,
    highBytes,
    breakdown: e,
    counts: { contentChapters, chapters: chapters.size, audiobookChapters, presentations, audiobookChaptersWithWords },
    limitBytes,
    verdict,
    warnings,
    error,
  };
}
