/**
 * Fase 5B.1 — clave de reuse ("restore-first") para el job `dynamic_package`.
 *
 * I2 (integral-review): antes, la clave era solo `sha256(sorted artifact ids)`
 * — así, un run empaquetado una vez no se podía volver a empaquetar nunca
 * más, ni siquiera después de corregir un bug del builder (`dynamic-mbz-
 * builder.ts`), porque el set de artifacts de origen era idéntico antes y
 * después del fix. Ahora la clave también depende de
 * `DYNAMIC_MBZ_BUILDER_VERSION`, y tanto `PackagingService.requestPackage`
 * (al decidir si reusar un job `completed`) como `dynamic-package-worker.ts`
 * (al decidir si reusar un artifact `dynamic_mbz` ya subido) usan esta misma
 * función — una sola fuente de verdad para no divergir.
 */
import { createHash } from 'crypto';
import type { ResolvedArtifact } from './packaging-types';

export function sortedArtifactIds(byItem: Map<string, ResolvedArtifact[]>): string[] {
  const ids: string[] = [];
  for (const list of byItem.values()) for (const a of list) ids.push(a.artifactId);
  return [...new Set(ids)].sort();
}

export function sourceIdsHash(builderVersion: string, ids: string[]): string {
  return createHash('sha256').update(`${builderVersion}:${ids.join(',')}`).digest('hex');
}
