/**
 * T6 (r57) — presupuesto de tamaño del `.mbz`, medido ANTES de subirlo.
 *
 * Un paquete que supera el límite de subida del almacenamiento (p. ej. el tope por objeto de Supabase Storage) fallaba
 * DESPUÉS de armarlo, con un 413 del proveedor. Ahora el worker mide el paquete armado y:
 *   - informa siempre el tamaño total y los archivos más pesados (`summary.size` del job);
 *   - con `PACKAGE_MBZ_WARN_BYTES` (o, si falta, el 90 % de `PACKAGE_MBZ_MAX_BYTES`), deja el aviso visible
 *     `package_size_over_warn:<bytes>:<umbral>` y empaqueta igual;
 *   - con `PACKAGE_MBZ_MAX_BYTES`, un paquete más grande falla ANTES de subir con `PACKAGE_SIZE_LIMIT_EXCEEDED`
 *     (retenido para una persona: config — subir el límite del almacenamiento o reducir el curso).
 * r61 (Q-24): el límite duro por defecto es el límite de subida del almacenamiento, `STORAGE_MAX_UPLOAD_BYTES`
 * (default 52.428.800 = 50 MB, el tope del plan Free de Supabase y el valor por defecto del proyecto). El mismo valor
 * lo usa la proyección ANTES de generar (`package-size-projection.ts`), así un curso que no cabe se rechaza antes de
 * gastar y el worker nunca intenta una subida que daría 413. `PACKAGE_MBZ_MAX_BYTES` sigue siendo un tope propio del
 * `.mbz` (más bajo); nunca puede superar un `STORAGE_MAX_UPLOAD_BYTES` explícito.
 * Un valor inválido (no entero positivo) → `PACKAGE_SIZE_CONFIG_INVALID` (fail loud, nunca un límite adivinado).
 * Puro salvo el unzip en memoria del directorio central (no infla blobs).
 */
import * as JSZip from 'jszip';

export const PACKAGE_MBZ_MAX_BYTES_ENV = 'PACKAGE_MBZ_MAX_BYTES';
export const PACKAGE_MBZ_WARN_BYTES_ENV = 'PACKAGE_MBZ_WARN_BYTES';
/** r61 (Q-24): límite de subida por objeto del almacenamiento (Supabase Storage → Settings → «Upload file size limit»). */
export const STORAGE_MAX_UPLOAD_BYTES_ENV = 'STORAGE_MAX_UPLOAD_BYTES';
/** 50 MB (50 × 1024²): el límite global por defecto de Supabase Storage y el máximo del plan Free. */
export const DEFAULT_STORAGE_MAX_UPLOAD_BYTES = 52_428_800;
export const PACKAGE_SIZE_LIMIT_EXCEEDED = 'PACKAGE_SIZE_LIMIT_EXCEEDED';
export const PACKAGE_SIZE_CONFIG_INVALID = 'PACKAGE_SIZE_CONFIG_INVALID';
export const PACKAGE_SIZE_OVER_WARN = 'package_size_over_warn';
/** Sin umbral de aviso explícito, se avisa desde este porcentaje del límite duro. */
export const PACKAGE_SIZE_DEFAULT_WARN_RATIO = 0.9;
/** Archivos más pesados que se informan. */
export const PACKAGE_SIZE_TOP_FILES = 10;

export interface PackageSizeLimits {
  warnBytes: number | null;
  maxBytes: number | null;
}

export interface PackageSizeStats {
  /** Bytes del `.mbz` tal como se sube. */
  totalBytes: number;
  /** Suma de los tamaños descomprimidos de las entradas del zip. */
  uncompressedBytes: number;
  entries: number;
  /** Las entradas más pesadas (descomprimidas), con el nombre del archivo de files.xml cuando es un blob. */
  largest: Array<{ path: string; bytes: number; filename?: string }>;
}

export interface PackageSizeVerdict {
  stats: PackageSizeStats;
  limits: PackageSizeLimits;
  warnings: string[];
  /** Mensaje de error (con código) si supera el límite duro; null si cabe. */
  error: string | null;
}

function parseBytes(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const t = raw.trim();
  if (!/^[1-9][0-9]*$/.test(t) || !Number.isSafeInteger(Number(t))) {
    throw new Error(`${PACKAGE_SIZE_CONFIG_INVALID}: ${name}="${raw}" no es un entero positivo de bytes (o sin definir)`);
  }
  return Number(t);
}

/** r61 (Q-24): límite de subida del almacenamiento (explícito o el default de 50 MB). */
export function storageUploadLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  return parseBytes(STORAGE_MAX_UPLOAD_BYTES_ENV, env[STORAGE_MAX_UPLOAD_BYTES_ENV]) ?? DEFAULT_STORAGE_MAX_UPLOAD_BYTES;
}

/**
 * Límites desde el entorno. Lanza PACKAGE_SIZE_CONFIG_INVALID con un valor mal formado, warn > max o un
 * PACKAGE_MBZ_MAX_BYTES mayor que un STORAGE_MAX_UPLOAD_BYTES explícito. r61: el máximo nunca es null (default =
 * límite de subida del almacenamiento).
 */
export function packageSizeLimitsFromEnv(env: Record<string, string | undefined> = process.env): PackageSizeLimits {
  const storageExplicit = parseBytes(STORAGE_MAX_UPLOAD_BYTES_ENV, env[STORAGE_MAX_UPLOAD_BYTES_ENV]);
  const mbzMax = parseBytes(PACKAGE_MBZ_MAX_BYTES_ENV, env[PACKAGE_MBZ_MAX_BYTES_ENV]);
  if (mbzMax !== null && storageExplicit !== null && mbzMax > storageExplicit) {
    throw new Error(`${PACKAGE_SIZE_CONFIG_INVALID}: ${PACKAGE_MBZ_MAX_BYTES_ENV} (${mbzMax}) > ${STORAGE_MAX_UPLOAD_BYTES_ENV} (${storageExplicit})`);
  }
  const maxBytes = mbzMax ?? storageExplicit ?? DEFAULT_STORAGE_MAX_UPLOAD_BYTES;
  const explicitWarn = parseBytes(PACKAGE_MBZ_WARN_BYTES_ENV, env[PACKAGE_MBZ_WARN_BYTES_ENV]);
  if (explicitWarn !== null && maxBytes !== null && explicitWarn > maxBytes) {
    throw new Error(`${PACKAGE_SIZE_CONFIG_INVALID}: ${PACKAGE_MBZ_WARN_BYTES_ENV} (${explicitWarn}) > ${PACKAGE_MBZ_MAX_BYTES_ENV} (${maxBytes})`);
  }
  const warnBytes = explicitWarn ?? Math.floor(maxBytes * PACKAGE_SIZE_DEFAULT_WARN_RATIO);
  return { warnBytes, maxBytes };
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** Mide el `.mbz` (directorio central; los blobs no se inflan). */
export async function measurePackageSize(mbz: Buffer): Promise<PackageSizeStats> {
  const zip = await JSZip.loadAsync(mbz);
  const sizes: Array<{ path: string; bytes: number }> = [];
  for (const [path, f] of Object.entries(zip.files)) {
    if (f.dir) continue;
    // JSZip expone el tamaño descomprimido del directorio central en `_data.uncompressedSize`.
    const bytes = Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize);
    sizes.push({ path, bytes: Number.isFinite(bytes) ? bytes : 0 });
  }
  sizes.sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1));
  const top = sizes.slice(0, PACKAGE_SIZE_TOP_FILES);
  // Nombre legible de los blobs (files/xx/<sha1> → filename de files.xml), solo para los informados.
  const filesXml = zip.file('files.xml') ? await zip.file('files.xml')!.async('string') : '';
  const nameByHash = new Map<string, string>();
  for (const m of filesXml.matchAll(/<contenthash>([0-9a-f]{40})<\/contenthash>[\s\S]*?<filename>([^<]*)<\/filename>/g)) {
    if (m[2] !== '.' && !nameByHash.has(m[1])) nameByHash.set(m[1], m[2]);
  }
  return {
    totalBytes: mbz.length,
    uncompressedBytes: sizes.reduce((s, x) => s + x.bytes, 0),
    entries: sizes.length,
    largest: top.map((x) => {
      const h = /^files\/[0-9a-f]{2}\/([0-9a-f]{40})$/.exec(x.path)?.[1];
      const filename = h ? nameByHash.get(h) : undefined;
      return filename ? { ...x, filename } : x;
    }),
  };
}

/** Veredicto del presupuesto para un paquete ya armado. */
export async function packageSizeBudget(mbz: Buffer, limits: PackageSizeLimits): Promise<PackageSizeVerdict> {
  const stats = await measurePackageSize(mbz);
  const warnings: string[] = [];
  let error: string | null = null;
  if (limits.maxBytes !== null && stats.totalBytes > limits.maxBytes) {
    const heavy = stats.largest.slice(0, 3).map((x) => `${x.filename ?? x.path} ${mb(x.bytes)}`).join(', ');
    error = `${PACKAGE_SIZE_LIMIT_EXCEEDED}: el paquete pesa ${stats.totalBytes} bytes (${mb(stats.totalBytes)}) y el límite de subida configurado es ` +
      `${limits.maxBytes} bytes (${mb(limits.maxBytes)}); no se sube. Lo más pesado: ${heavy}. Para entregarlo: un administrador sube el ` +
      `límite de subida de Supabase Storage (plan Pro o superior; Storage → Settings → «Upload file size limit») a ≥ ${mb(stats.totalBytes)} y ` +
      `configura el mismo valor en ${STORAGE_MAX_UPLOAD_BYTES_ENV} del backend, y reintenta «Preparar paquete» (USD 0: el contenido ya está generado).`;
  } else if (limits.warnBytes !== null && stats.totalBytes > limits.warnBytes) {
    warnings.push(`${PACKAGE_SIZE_OVER_WARN}:${stats.totalBytes}:${limits.warnBytes}`);
  }
  return { stats, limits, warnings, error };
}
