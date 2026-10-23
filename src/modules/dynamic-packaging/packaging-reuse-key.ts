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
import { MOODLE_VERSIONS } from '../../package/mbz-common';

export function sortedArtifactIds(byItem: Map<string, ResolvedArtifact[]>): string[] {
  const ids: string[] = [];
  for (const list of byItem.values()) for (const a of list) ids.push(a.artifactId);
  return [...new Set(ids)].sort();
}

export function sourceIdsHash(builderVersion: string, ids: string[]): string {
  return createHash('sha256').update(`${builderVersion}:${ids.join(',')}`).digest('hex');
}

// ─── I3 (review-it2): versión de Moodle del .mbz dinámico ─────────────────
// `DYNAMIC_MBZ_MOODLE_VERSION` antes caía en silencio a 4.1 ante un valor
// desconocido (resolveMoodleVersion) mientras la metadata registraba el valor
// pedido — un .mbz 4.1 etiquetado como otra versión. Ahora un valor
// desconocido lanza (el job de empaquetado falla ruidoso) y la versión
// RESUELTA entra en la clave de reuse.

export const DYNAMIC_MBZ_MOODLE_VERSION_ENV = 'DYNAMIC_MBZ_MOODLE_VERSION';
/** Default del builder (mbz-common.ts resolveMoodleVersion) cuando no se pasa versión. */
export const DEFAULT_DYNAMIC_MOODLE_VERSION = '4.1';

export interface DynamicMoodleVersion {
  /** Valor pedido por env (trim); undefined si no se configuró → el builder usa su default. */
  requested: string | undefined;
  /** Versión efectiva del .mbz (clave de MOODLE_VERSIONS). */
  resolved: string;
}

export function resolveDynamicMoodleVersion(env: NodeJS.ProcessEnv = process.env): DynamicMoodleVersion {
  const raw = (env[DYNAMIC_MBZ_MOODLE_VERSION_ENV] ?? '').trim();
  if (raw === '') return { requested: undefined, resolved: DEFAULT_DYNAMIC_MOODLE_VERSION };
  if (!Object.prototype.hasOwnProperty.call(MOODLE_VERSIONS, raw)) {
    throw new Error(
      `${DYNAMIC_MBZ_MOODLE_VERSION_ENV} inválido: "${raw}". Valores permitidos: ${Object.keys(MOODLE_VERSIONS).join(', ')} ` +
        `(o sin definir = ${DEFAULT_DYNAMIC_MOODLE_VERSION}).`,
    );
  }
  return { requested: raw, resolved: raw };
}

/**
 * Clave de reuse de un `dynamic_mbz`: builderVersion + ids de origen + versión
 * de Moodle RESUELTA. Para la versión default (4.1) es BYTE-IDÉNTICA a
 * `sourceIdsHash(builderVersion, ids)` — así los `dynamic_mbz` ya subidos (y
 * los hashes fijados en jobs `completed`) siguen reusándose sin cambios. Un
 * .mbz construido para otra versión nunca comparte clave con el default.
 */
export function packageReuseHash(builderVersion: string, ids: string[], moodleVersion: string): string {
  if (moodleVersion === DEFAULT_DYNAMIC_MOODLE_VERSION) return sourceIdsHash(builderVersion, ids);
  return createHash('sha256').update(`${builderVersion}:moodle=${moodleVersion}:${ids.join(',')}`).digest('hex');
}
