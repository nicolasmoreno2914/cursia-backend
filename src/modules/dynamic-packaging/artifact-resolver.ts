/**
 * Fase 5B.1 — B1 (PLACEHOLDER, bloque en paralelo).
 *
 * Stand-in mínimo de `resolveRunArtifacts` / `loadArtifactText` /
 * `parseDynamicVideo`, escrito por B3 solo para compilar y probar el
 * endpoint + worker mientras B1 construye la versión real (spec §4). B1
 * reemplaza este archivo entero al integrar; la firma exportada y
 * `PackagingNotReadyError` (definida en `packaging-types.ts`, re-exportada
 * acá) son el contrato compartido.
 */

import type { DataSource } from 'typeorm';
import type { GenerationManifestV1, ResolvedArtifact } from './packaging-types';
import { PackagingNotReadyError } from './packaging-types';

export { PackagingNotReadyError };

/** Fila cruda de generation_item_runs + artifacts unidos por item_run_id. */
interface ResolvedRow {
  item_key: string;
  item_run_id: string;
  status: string;
  artifact_id: string | null;
  artifact_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
}

/**
 * Valida que el run esté `completed` y que cada item del Manifest tenga
 * exactamente un artifact `ready` vinculado por `item_run_id` (nunca por
 * ruta) — si no, lanza `PackagingNotReadyError` con la lista de itemKeys
 * faltantes, en el orden del Manifest.
 */
export async function resolveRunArtifacts(
  ctx: { query: DataSource['query'] },
  runId: string,
  manifest: { manifest: GenerationManifestV1 },
): Promise<Map<string, ResolvedArtifact[]>> {
  const rows: ResolvedRow[] = await ctx.query(
    `select gir.item_key, gir.id as item_run_id, gir.status,
            a.id as artifact_id, a.type as artifact_type,
            a.storage_bucket, a.storage_path, a.mime_type
       from public.generation_item_runs gir
       left join public.artifacts a
         on a.item_run_id = gir.id and a.status = 'ready'
      where gir.job_id = $1`,
    [runId],
  );
  const byItemKey = new Map<string, ResolvedRow[]>();
  for (const r of rows) {
    const list = byItemKey.get(r.item_key) ?? [];
    list.push(r);
    byItemKey.set(r.item_key, list);
  }

  const missing: string[] = [];
  const result = new Map<string, ResolvedArtifact[]>();
  for (const item of manifest.manifest.items) {
    const rowsForItem = byItemKey.get(item.key) ?? [];
    const completedRow = rowsForItem.find((r) => r.status === 'completed' && r.artifact_id);
    if (!completedRow) {
      missing.push(item.key);
      continue;
    }
    result.set(item.key, [
      {
        itemKey: item.key,
        itemRunId: completedRow.item_run_id,
        artifactId: completedRow.artifact_id as string,
        type: completedRow.artifact_type as ResolvedArtifact['type'],
        storageBucket: completedRow.storage_bucket as string,
        storagePath: completedRow.storage_path as string,
        mimeType: completedRow.mime_type,
      },
    ]);
  }

  if (missing.length > 0) {
    throw new PackagingNotReadyError(missing);
  }
  return result;
}

/** Descarga el contenido de texto de un artifact (markdown, HTML, XML, GIFT). */
export async function loadArtifactText(
  artifactsService: { getDownloadUrl(id: string, ownerId: string, ttl?: number): Promise<{ url?: string }> },
  ownerId: string,
  artifact: ResolvedArtifact,
): Promise<string> {
  const { url } = await artifactsService.getDownloadUrl(artifact.artifactId, ownerId, 3600);
  if (!url) throw new Error(`sin URL de descarga para el artifact ${artifact.artifactId} (${artifact.type})`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`descarga del artifact ${artifact.artifactId} (${artifact.type}) falló (HTTP ${res.status})`);
  return res.text();
}

/**
 * Parsea el JSON de un artifact `dynamic_video` (mismo payload que sube
 * `dynamic-item-worker.ts::completeVideoItem`) al par {url, videogenJobId}
 * que consume el builder. 5B.1 usa SOLO la downloadUrl pública de Videogen
 * (nunca una signed URL temporal) — ver packaging-types.ts.
 */
export function parseDynamicVideo(json: unknown): { url: string; videogenJobId: string } {
  const obj = json as Record<string, any>;
  const url = obj?.downloadUrl;
  const videogenJobId = obj?.videogenJobId;
  if (typeof url !== 'string' || !url) {
    throw new Error('artifact dynamic_video sin downloadUrl (no se puede empaquetar sin URL pública del video)');
  }
  if (typeof videogenJobId !== 'string' || !videogenJobId) {
    throw new Error('artifact dynamic_video sin videogenJobId');
  }
  return { url, videogenJobId };
}
