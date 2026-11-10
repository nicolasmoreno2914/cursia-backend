/**
 * r107 B10 · Fase 3 — guardar y volver a cargar el RESULTADO producido (artifact `workshop_regen_result`, solo
 * servidor): en la carpeta del dueño de la sesión, atado a la aprobación que lo pagó (`metadata.approvalId`), con su
 * sha256. Al cargarlo se verifica dueño, tipo, sesión, tamaño y huella: un resultado alterado o ajeno nunca llega al motor.
 */
import type { DataSource } from 'typeorm';
import type { ArtifactsService } from '../../artifacts/artifacts.service';
import { WORKSHOP_BUCKET } from '../course-workshop.service';
import { decodeProduced, encodeProduced, producedSummary, sha256Hex } from './bundle';
import { ProducedRegen, RegenerateOp, isRegenOperation } from './types';

export const REGEN_RESULT_TYPE = 'workshop_regen_result';
export const REGEN_RESULT_MIME = 'application/zip';
/** Tope de un resultado (un audiolibro completo de un curso grande a 64 kbps ronda 30–60 MB). */
export const REGEN_RESULT_MAX_BYTES = 250 * 1024 * 1024;

export interface RegenResultRef { artifactId: string; sha256: string; bytes: number }

export function regenResultPath(ownerId: string, sessionId: string, approvalId: string, itemId: string, sha256: string): string {
  return `${ownerId}/workshop/${sessionId}/regen/${approvalId}/${itemId}-${sha256.slice(0, 12)}.zip`;
}

export async function storeRegenResult(ds: Pick<DataSource, 'query'>, artifacts: Pick<ArtifactsService, 'putStorageObject' | 'deleteUnreferencedServerObject'>, a: { ownerId: string; sessionId: string; approvalId: string; itemId: string; requestId: string; operation: string; produced: ProducedRegen }): Promise<RegenResultRef> {
  const buf = await encodeProduced(a.produced);
  const sha256 = sha256Hex(buf);
  const path = regenResultPath(a.ownerId, a.sessionId, a.approvalId, a.itemId, sha256);
  await artifacts.putStorageObject({ ownerId: a.ownerId, storagePath: path, buffer: buf, mimeType: REGEN_RESULT_MIME, storageBucket: WORKSHOP_BUCKET, upsert: true });
  try {
    const [row] = await ds.query(
      `insert into public.artifacts (owner_id, course_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, size_bytes, checksum_sha256, metadata)
       values ($1, null, $2, 'supabase', $3, $4, $5, $6, $7, $8, $9::jsonb) returning id::text as id`,
      [a.ownerId, REGEN_RESULT_TYPE, WORKSHOP_BUCKET, path, path.split('/').pop(), REGEN_RESULT_MIME, buf.length, sha256,
        JSON.stringify({ workshopSessionId: a.sessionId, approvalId: a.approvalId, itemId: a.itemId, requestId: a.requestId, operation: a.operation, summary: producedSummary(a.produced) })]);
    return { artifactId: row.id, sha256, bytes: buf.length };
  } catch (err) {
    // Nunca un objeto huérfano: sin fila, el objeto subido se borra (solo si nadie lo nombra).
    await artifacts.deleteUnreferencedServerObject(a.ownerId, WORKSHOP_BUCKET, path).catch(() => undefined);
    throw err;
  }
}

export async function loadRegenResult(ds: Pick<DataSource, 'query'>, artifacts: Pick<ArtifactsService, 'downloadStorageObjectCapped'>, s: { id: string; ownerId: string }, ref: RegenResultRef): Promise<ProducedRegen> {
  if (!ref || typeof ref.artifactId !== 'string' || !/^[0-9a-f]{64}$/.test(String(ref.sha256))) throw new Error('el ítem no trae la referencia a su resultado');
  const [row] = await ds.query(
    `select storage_bucket, storage_path, size_bytes, checksum_sha256, metadata from public.artifacts where id::text = $1 and owner_id::text = $2 and type = $3`,
    [ref.artifactId, s.ownerId, REGEN_RESULT_TYPE]);
  if (!row) throw new Error('el resultado de la regeneración ya no está');
  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {};
  if (meta.workshopSessionId !== s.id) throw new Error('el resultado es de otra sesión');
  if (row.checksum_sha256 !== ref.sha256) throw new Error('el resultado guardado no coincide con el que se aprobó');
  const buf = await artifacts.downloadStorageObjectCapped(row.storage_bucket, row.storage_path, { maxBytes: REGEN_RESULT_MAX_BYTES, sizeHint: Number(row.size_bytes) || null, timeoutMs: 5 * 60_000 });
  if (sha256Hex(buf) !== ref.sha256) throw new Error('el archivo del resultado cambió desde que se aprobó');
  return decodeProduced(buf);
}

/** Parámetros del motor con el resultado cargado (las demás operaciones, tal cual). */
export async function resolveRegenParams<T>(ds: Pick<DataSource, 'query'>, artifacts: Pick<ArtifactsService, 'downloadStorageObjectCapped'>, s: { id: string; ownerId: string }, params: T): Promise<T> {
  // Libro v3: el PDF que armó el builder con el markdown aprobado (guardado al generar) → `pdf` para el motor.
  const lb = params as unknown as { op?: string; pdf?: unknown; libroV3?: { result?: RegenResultRef } };
  if (lb && lb.op === 'edit_libro_section' && !lb.pdf && lb.libroV3?.result) {
    const r = await loadRegenResult(ds, artifacts, s, lb.libroV3.result);
    if (r.kind !== 'libro_pdf') throw new Error('el resultado guardado del Libro no es un PDF');
    return { ...(lb as object), pdf: { base64: r.pdf.toString('base64'), previousSha1: r.previousSha1 } } as unknown as T;
  }
  const p = params as unknown as RegenerateOp;
  if (!p || !isRegenOperation(p.op)) return params;
  if (!p.result) throw new Error(`el ítem «${p.op}» no tiene su resultado producido`);
  const produced = await loadRegenResult(ds, artifacts, s, p.result);
  return { ...(p as object), produced } as unknown as T;
}
