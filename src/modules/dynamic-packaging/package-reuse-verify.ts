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
 * Si no → se reconstruye (y el upload reemplaza el objeto no verificado: `replaceUnverifiedOnConflict`).
 */
import { createHash } from 'crypto';
import { QA_INTERNAL_STORAGE_PREFIX } from './qa-package';

/** Prefijo del aviso de log cuando un candidato a reuse se descarta (informativo: el job reconstruye, no falla). */
export const PACKAGE_REUSE_REJECTED = 'PACKAGE_REUSE_REJECTED';
export const MBZ_ARTIFACT_BUCKET = 'cursia-artifacts';
const QA_FILENAME_PREFIX = 'QA-VISTA-PREVIA-';

export type PackageReuseRejectReason =
  | 'wrong_bucket'
  | 'non_canonical_path'
  | 'missing_checksum'
  | 'not_validated'
  | 'download_failed'
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
  if (row.storagePath !== canonicalDynamicMbzPath(expected)) return { ok: false, reason: 'non_canonical_path' };
  const checksum = String(row.checksumSha256 ?? '').toLowerCase();
  if (!SHA_RE.test(checksum)) return { ok: false, reason: 'missing_checksum' };
  if (opts.requireValidated && String(row.metadata?.validatedSha256 ?? '').toLowerCase() !== checksum) {
    return { ok: false, reason: 'not_validated' };
  }
  if (typeof artifacts.downloadStorageObject !== 'function') return { ok: false, reason: 'download_failed' };
  let bytes: Buffer;
  try {
    bytes = await artifacts.downloadStorageObject(bucket, row.storagePath as string, 120_000);
  } catch {
    return { ok: false, reason: 'download_failed' };
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual === checksum ? { ok: true } : { ok: false, reason: 'checksum_mismatch' };
}
