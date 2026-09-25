import type { ManifestRulesVersion } from './generation-manifest-builder';

/**
 * rulesVersion que crea `POST …/manifest` (y que leen los endpoints "del
 * Manifest actual" de un Blueprint). Spec v2 §3: sale de config
 * `DYNAMIC_MANIFEST_RULES_VERSION` ∈ {1, 2}, default 1 hasta que v2 esté
 * completo y validado.
 *
 * Fail-fast: cualquier otro valor (incluido "v2", " 2 ", "3") lanza — nunca
 * se cae en silencio a otra versión. GenerationManifestsService lo lee en cada
 * uso (lanza ahí) y, en el constructor, solo lo loguea como error: un valor
 * inválido nunca aborta el boot de la API legacy ni de los workers (I4
 * review-rv2).
 */
export const MANIFEST_RULES_VERSION_ENV = 'DYNAMIC_MANIFEST_RULES_VERSION';

export function readManifestRulesVersionConfig(env: NodeJS.ProcessEnv = process.env): ManifestRulesVersion {
  const raw = env[MANIFEST_RULES_VERSION_ENV];
  if (raw === undefined || raw === '') return 1;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  throw new Error(
    `${MANIFEST_RULES_VERSION_ENV} inválido: ${JSON.stringify(raw)} (valores permitidos: "1" o "2"; ausente = 1)`,
  );
}
