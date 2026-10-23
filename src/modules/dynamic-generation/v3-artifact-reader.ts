/**
 * R11a — lector del contenido de un artifact recién subido por el ejecutor,
 * para la validación server-side de los items LLM de rulesVersion 3 en
 * `SchedulerService.completeItemDetailed`. Implementación real: URL firmada
 * de `ArtifactsService` + fetch con timeout (misma ruta que el empaquetado,
 * `loadArtifactText`). Los tests inyectan un lector falso.
 */
import type { ArtifactsService } from '../artifacts/artifacts.service';
import { loadArtifactText } from '../dynamic-packaging/artifact-resolver';
import type { ResolvedArtifact } from '../dynamic-packaging/packaging-types';

export const V3_ARTIFACT_TEXT_READER = 'V3_ARTIFACT_TEXT_READER';

export interface V3ArtifactRef {
  id: string;
  ownerId: string;
  itemKey: string;
  itemRunId: string;
  type: string;
  storageBucket: string;
  storagePath: string;
}

export interface V3ArtifactTextReader {
  readText(a: V3ArtifactRef): Promise<string>;
}

/** Tope defensivo: un JSON/GIFT de un item LLM nunca pesa esto. */
export const V3_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

export class ArtifactsServiceTextReader implements V3ArtifactTextReader {
  constructor(private readonly artifacts: ArtifactsService) {}

  async readText(a: V3ArtifactRef): Promise<string> {
    const resolved = {
      itemKey: a.itemKey,
      itemRunId: a.itemRunId,
      artifactId: a.id,
      type: a.type as ResolvedArtifact['type'],
      storageBucket: a.storageBucket,
      storagePath: a.storagePath,
      mimeType: null,
    } as ResolvedArtifact;
    const text = await loadArtifactText(this.artifacts, a.ownerId, resolved);
    if (Buffer.byteLength(text, 'utf8') > V3_ARTIFACT_MAX_BYTES) {
      throw new Error(`V3_ARTIFACT_TOO_LARGE: el artifact ${a.id} (${a.type}) supera ${V3_ARTIFACT_MAX_BYTES} bytes`);
    }
    return text;
  }
}
