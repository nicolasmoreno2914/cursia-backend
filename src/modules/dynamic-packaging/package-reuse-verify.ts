/**
 * r58 (AU1 R1) — restore-first del worker de empaque SOLO sobre un `.mbz` que el servidor construyó (y, en v3,
 * validó). Antes bastaba que la metadata del artifact `dynamic_mbz` coincidiera (runId, clave de reuse,
 * builder): un artifact registrado por el cliente (o un objeto reemplazado en la carpeta del dueño) se marcaba
 * como el paquete del run sin construirlo ni validarlo.
 *
 * Un candidato se reutiliza solo si:
 *  1. bucket = `cursia-artifacts` y storage path = la ruta CANÓNICA que escribe el worker
 *     (`[qa-internal/]<owner>/dynamic/<course>/<manifest>/dynamic_mbz/<run>/[QA-VISTA-PREVIA-]<clave>.mbz`);
 *  2. tiene `checksum_sha256` (lo registra el servidor al subir) y, en v3, `metadata.validatedSha256` igual
 *     (se escribe solo después de que `validateMbzV3` aprobó esos bytes);
 *  3. los bytes que hay HOY en Storage tienen ese sha256 (la carpeta del dueño es escribible por el dueño).
 * Si no → se reconstruye. Review r1 (I-1): el rebuild NUNCA sobrescribe un objeto que un artifact referencia
 * (bytes entregados): se escribe a `<clave>.<sha16 del build>.mbz` (ruta nueva, misma carpeta) y se crea un row
 * nuevo. Un fallo TRANSITORIO al descargar el candidato (`download_failed`): r62 (K4) el candidato no se reutiliza y
 * el job reconstruye en la ruta nueva (antes fallaba con PACKAGE_REUSE_VERIFY_UNAVAILABLE y terminaba en retry_package);
 * como nada referenciado se pisa, es seguro y cuesta 0. Un objeto inexistente (404/400) también se reconstruye
 * (`object_missing`).
 */
import { createHash } from 'crypto';
import { QA_INTERNAL_STORAGE_PREFIX } from './qa-package';

/** Prefijo del aviso de log cuando un candidato a reuse se descarta (informativo: el job reconstruye, no falla). */
export const PACKAGE_REUSE_REJECTED = 'PACKAGE_REUSE_REJECTED';
/** Review r1 (I-1): no se pudo descargar un candidato para verificarlo (Storage transitorio). r62 (K4): aviso de log; se reconstruye en una ruta nueva. */
export const PACKAGE_REUSE_VERIFY_UNAVAILABLE = 'PACKAGE_REUSE_VERIFY_UNAVAILABLE';
export const MBZ_ARTIFACT_BUCKET = 'cursia-artifacts';
const QA_FILENAME_PREFIX = 'QA-VISTA-PREVIA-';

export type PackageReuseRejectReason =
  | 'wrong_bucket'
  | 'non_canonical_path'
  | 'missing_checksum'
  | 'not_validated'
  | 'download_failed'
  | 'object_missing'
  | 'checksum_mismatch';

export interface CanonicalMbzPathInput {
  ownerId: string;
  courseId: string;
  manifestId: number;
  runId: string;
  sourceIdsHash: string;
  qa: boolean;
}

/** Ruta canónica del `.mbz` del run (la misma que arma el worker al subir). */
export function canonicalDynamicMbzPath(i: CanonicalMbzPathInput): string {
  const filename = `${i.qa ? QA_FILENAME_PREFIX : ''}${i.sourceIdsHash}.mbz`;
  return `${i.qa ? `${QA_INTERNAL_STORAGE_PREFIX}/` : ''}${i.ownerId}/dynamic/${i.courseId}/${i.manifestId}/dynamic_mbz/${i.runId}/${filename}`;
}

/** Review r1 (I-1): variante de rebuild — misma carpeta y clave + los primeros 16 hex del sha256 de los bytes construidos. */
export function rebuildDynamicMbzPath(canonical: string, builtSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(builtSha256)) throw new Error('rebuildDynamicMbzPath: sha256 inválido');
  return canonical.replace(/\.mbz$/, `.${builtSha256.slice(0, 16)}.mbz`);
}

/** ¿`p` es la ruta canónica del run o su variante de rebuild (`<clave>.<16 hex>.mbz`)? */
export function isCanonicalDynamicMbzPath(p: string | null | undefined, i: CanonicalMbzPathInput): boolean {
  if (typeof p !== 'string') return false;
  const canonical = canonicalDynamicMbzPath(i);
  if (p === canonical) return true;
  const stem = canonical.slice(0, -'.mbz'.length);
  return p.length === stem.length + 1 + 16 + 4 && p.startsWith(stem + '.') && /^\.[0-9a-f]{16}\.mbz$/.test(p.slice(stem.length));
}

/**
 * Review r1 (I-1): ruta donde el worker sube un `.mbz` recién construido. La canónica, salvo que un artifact ya la
 * referencie (paquete entregado — sus bytes son inmutables): entonces la variante de rebuild con el sha del build.
 */
export async function chooseDynamicMbzUploadPath(
  artifacts: { isStoragePathReferenced?(bucket: string, storagePath: string): Promise<boolean> },
  canonical: string,
  builtSha256: string,
): Promise<{ storagePath: string; rebuilt: boolean }> {
  // Fakes de harnesses previos sin la consulta: ruta canónica (la guarda de putStorageObject sigue sin pisar).
  if (typeof artifacts.isStoragePathReferenced !== 'function') return { storagePath: canonical, rebuilt: false };
  if (!(await artifacts.isStoragePathReferenced(MBZ_ARTIFACT_BUCKET, canonical))) return { storagePath: canonical, rebuilt: false };
  return { storagePath: rebuildDynamicMbzPath(canonical, builtSha256), rebuilt: true };
}

export interface ReuseCandidateRow {
  id: string;
  storageBucket?: string | null;
  storagePath?: string | null;
  checksumSha256?: string | null;
  metadata?: Record<string, any> | null;
}

export interface ReuseDownloader {
  downloadStorageObject(bucket: string, storagePath: string, timeoutMs?: number): Promise<Buffer>;
}

const SHA_RE = /^[0-9a-f]{64}$/;

export async function verifyReusableDynamicMbz(
  artifacts: ReuseDownloader,
  row: ReuseCandidateRow,
  expected: CanonicalMbzPathInput,
  opts: { requireValidated: boolean },
): Promise<{ ok: true } | { ok: false; reason: PackageReuseRejectReason }> {
  const bucket = row.storageBucket ?? MBZ_ARTIFACT_BUCKET;
  if (bucket !== MBZ_ARTIFACT_BUCKET) return { ok: false, reason: 'wrong_bucket' };
  if (!isCanonicalDynamicMbzPath(row.storagePath, expected)) return { ok: false, reason: 'non_canonical_path' };
  const checksum = String(row.checksumSha256 ?? '').toLowerCase();
  if (!SHA_RE.test(checksum)) return { ok: false, reason: 'missing_checksum' };
  if (opts.requireValidated && String(row.metadata?.validatedSha256 ?? '').toLowerCase() !== checksum) {
    return { ok: false, reason: 'not_validated' };
  }
  if (typeof artifacts.downloadStorageObject !== 'function') return { ok: false, reason: 'download_failed' };
  let bytes: Buffer;
  try {
    bytes = await artifacts.downloadStorageObject(bucket, row.storagePath as string, 120_000);
  } catch (err) {
    // Objeto inexistente (Supabase: 404, o 400 «not found») → se reconstruye; cualquier otro fallo es transitorio.
    const msg = err instanceof Error ? err.message : String(err);
    if (/download failed: (404|400)\b/.test(msg)) return { ok: false, reason: 'object_missing' };
    return { ok: false, reason: 'download_failed' };
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual === checksum ? { ok: true } : { ok: false, reason: 'checksum_mismatch' };
}
