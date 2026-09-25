import type { ResolvedArtifact } from './packaging-types';

export interface PackagingWarning {
  code: 'stale_artifact';
  itemKey: string;
  artifactId: string;
  type: ResolvedArtifact['type'];
  message: string;
}

/**
 * Fase 8 (spec §4 paso 4): el packaging incluye los artifacts `stale`
 * (STALE_NO_AUTO: p.ej. un video que no se regenera solo porque cuesta) pero
 * lo deja VISIBLE en `output_summary.warnings` del job de empaquetado. PURA y
 * determinística (orden por itemKey, tipo, artifactId).
 */
export function staleArtifactWarnings(byItem: Map<string, ResolvedArtifact[]>): PackagingWarning[] {
  const out: PackagingWarning[] = [];
  for (const list of byItem.values()) {
    for (const a of list) {
      if (a.status !== 'stale') continue;
      out.push({
        code: 'stale_artifact',
        itemKey: a.itemKey,
        artifactId: a.artifactId,
        type: a.type,
        message:
          `El artifact ${a.type} de ${a.itemKey} quedó desactualizado por un cambio de estructura y se empaquetó igual ` +
          '(no se regenera automáticamente: revisalo o pedí regenerarlo).',
      });
    }
  }
  return out.sort((x, y) =>
    x.itemKey < y.itemKey ? -1 : x.itemKey > y.itemKey ? 1 : x.type < y.type ? -1 : x.type > y.type ? 1 : x.artifactId < y.artifactId ? -1 : x.artifactId > y.artifactId ? 1 : 0,
  );
}
