/**
 * r61 (Q-24) — proyección del tamaño del `.mbz` v3 ANTES de generar (antes de gastar).
 *
 * El presupuesto de tamaño del worker de empaque (`package-size-budget.ts`) mide el paquete YA armado: un curso que no
 * cabe en el límite de subida del almacenamiento falla ahí, después de pagar todo el contenido, el audio y las
 * presentaciones (#1353: 106 MB, 413 EntityTooLarge con el límite de 50 MB). Esta proyección corre en la vista previa
 * del inicio y en `startRun`: si el tamaño ESPERADO supera el límite configurado, el run nuevo no se crea (409 con
 * acción); si solo el tamaño ALTO lo supera, se avisa.
 *
 * Modelo (bytes del `.mbz` tal como se sube; el zip casi no comprime mp3/pdf/png). Calibrado con el `.mbz` real de
 * #1353 (artifact c2df5f60, 111.561.795 bytes; 12 capítulos de contenido + 3 de práctica):
 *   - audiolibro: 48 kbps mono (AUDIOBOOK_TARGET_BITRATE_KBPS) × minutos por capítulo de contenido. #1353 midió
 *     89.906.112 bytes / 12 = 7,49 MB ≈ 20,8 min por capítulo (máx. 24 min). Esperado 20 min, alto 25 min.
 *   - bienvenida: 64 kbps; #1353 = 519.360 bytes. Esperado 0,6 MB, alto 1,0 MB.
 *   - presentación por capítulo de contenido (PDF + portada PNG): #1353 media 1,14 MB + 0,56 MB (máx. 1,61 + 0,77).
 *     Esperado 1,75 MB, alto 2,4 MB.
 *   - resto por capítulo (XML de actividades, H5P, PDF de aplicación): #1353 ≈ 0,17 MB. Esperado 0,25 MB, alto 0,4 MB.
 *   - fijo del curso (Libro Guía PDF, preguntas, insignia, manifiesto): #1353 ≈ 0,8 MB. Esperado 1 MB, alto 2 MB.
 *   - video: 0 (va a YouTube no listado; el `.mbz` solo lleva el enlace + el H5P interactivo).
 *   - proveedor en modo mock: medios sintéticos (MP3 silencioso de 8 kbps, PDF en blanco) → 50 KB por item.
 * Con #1353 el modelo da ≈ 112 MB esperado (real 106,4 MB): conservador por ≈ 5 %.
 *
 * Puro: sin I/O, sin reloj.
 */
import { AUDIOBOOK_TARGET_BITRATE_KBPS } from '../audio/audiobook-policy';
import { PackageSizeLimits } from './package-size-budget';

export const PACKAGE_SIZE_PROJECTED_OVER_LIMIT = 'PACKAGE_SIZE_PROJECTED_OVER_LIMIT';
export const PACKAGE_SIZE_PROJECTED_HIGH_OVER_LIMIT = 'package_size_projected_high_over_limit';
export const PACKAGE_SIZE_PROJECTION_VERSION = 'r61-q24-v1';

const MB = 1024 * 1024;
const AUDIO_BYTES_PER_SECOND = (AUDIOBOOK_TARGET_BITRATE_KBPS * 1000) / 8;

export const PACKAGE_SIZE_MODEL = Object.freeze({
  audiobookMinutesPerChapter: { expected: 20, high: 25 },
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
  counts: { contentChapters: number; chapters: number; audiobookChapters: number; presentations: number };
  limitBytes: number | null;
  /** ok = cabe incluso en el caso alto; warn = el esperado cabe, el alto no; over = el esperado no cabe. */
  verdict: 'ok' | 'warn' | 'over';
  warnings: string[];
  /** Mensaje accionable (código al inicio) cuando verdict = over. */
  error: string | null;
}

export const mbText = (n: number): string => `${(n / MB).toFixed(1)} MB`;

/** Proyección del `.mbz` desde los items del Manifest v3 y los modos de proveedor congelados para el run. */
export function projectPackageSize(items: readonly ProjectionItem[], modes: ProjectionModes, limits: Pick<PackageSizeLimits, 'maxBytes'>): PackageSizeProjection {
  if (!Array.isArray(items)) throw new Error('projectPackageSize necesita items[]');
  const M = PACKAGE_SIZE_MODEL;
  const chapters = new Set<string>();
  let contentChapters = 0;
  let audiobookChapters = 0;
  let presentations = 0;
  let welcome = 0;
  for (const it of items) {
    if (it.chapterId) chapters.add(String(it.chapterId));
    if (it.type === 'content') contentChapters++;
    else if (it.type === 'audiobook_chapter') audiobookChapters++;
    else if (it.type === 'presentation') presentations++;
    else if (it.type === 'audio_welcome') welcome++;
  }
  const audioReal = modes.audio !== 'mock';
  const presReal = modes.presentation !== 'mock';
  const at = (k: 'expected' | 'high') => {
    const audiobook = audioReal ? audiobookChapters * M.audiobookMinutesPerChapter[k] * 60 * AUDIO_BYTES_PER_SECOND : audiobookChapters * M.mockMediaBytes;
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
  if (limitBytes !== null && expectedBytes > limitBytes) {
    verdict = 'over';
    const parts = [
      `audiolibro ${mbText(e.audiobook)} (${audiobookChapters} capítulos × ≈${M.audiobookMinutesPerChapter.expected} min a ${AUDIOBOOK_TARGET_BITRATE_KBPS} kbps)`,
      `presentaciones ${mbText(e.presentations)}`,
      `resto ${mbText(e.welcome + e.other + e.fixed)}`,
    ].join(', ');
    error =
      `${PACKAGE_SIZE_PROJECTED_OVER_LIMIT}: el paquete para Moodle de este curso pesaría ≈ ${mbText(expectedBytes)} (hasta ${mbText(highBytes)}) ` +
      `y el límite de subida del almacenamiento configurado es ${mbText(limitBytes)}; el curso no se podría entregar. ` +
      `Detalle: ${parts}. No se generó nada ni se gastó. ` +
      `Para continuar: un administrador sube el límite de subida de Supabase Storage (plan Pro o superior; Storage → Settings → «Upload file size limit») ` +
      `a ≥ ${mbText(highBytes)} y configura el mismo valor en STORAGE_MAX_UPLOAD_BYTES del backend; o reduce el curso (menos capítulos de contenido).`;
  } else if (limitBytes !== null && highBytes > limitBytes) {
    verdict = 'warn';
    warnings.push(`${PACKAGE_SIZE_PROJECTED_HIGH_OVER_LIMIT}:${highBytes}:${limitBytes}`);
  }
  return {
    version: PACKAGE_SIZE_PROJECTION_VERSION,
    expectedBytes,
    highBytes,
    breakdown: e,
    counts: { contentChapters, chapters: chapters.size, audiobookChapters, presentations },
    limitBytes,
    verdict,
    warnings,
    error,
  };
}
